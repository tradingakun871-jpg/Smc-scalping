import express from "express";
import crypto from "crypto";
import {analyzeSMC,analyzeRollingM5} from "./smc.js";
import {aiDecision} from "./ai.js";
import {getFundamental} from "./fundamental.js";
import {initDb,checkDb,touchHeartbeat,getHeartbeat,saveM5Candle,getM5Block,getCurrentM5Count,saveTradeSignal,updateOpenTrades,updateOpenTradesFromPrice,expirePendingTrades,getTradeStats,getTradeJournal,getLatestOpenTrade,hasTradeSignal,normalizeLegacyHourlySignals,getLatestTrade} from "./db.js";
const app=express();app.use(express.json({limit:"1mb"}));app.use(express.static("public"));
const buffers=new Map(),lastSignal=new Map(),latest=new Map(),aiRuntime=new Map(),livePrice=new Map();let lastMt5At=0;
const minTech=Number(process.env.MIN_TECHNICAL_SCORE||70),minFinal=Number(process.env.MIN_FINAL_SCORE||70);
function bridgeAuth(req,res,next){const expected=process.env.BRIDGE_TOKEN;if(!expected)return res.status(503).json({error:"BRIDGE_TOKEN not configured"});const auth=req.get("authorization")||"";const token=auth.startsWith("Bearer ")?auth.slice(7):"";const a=Buffer.from(token),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:"Unauthorized bridge"});next();}

async function sendTelegramSignal(symbol,record){
 const r=record?.result;
 const hourly=record?.mode==="HOURLY_D1_MTF_ANALYSIS";
 if(!r||(!hourly&&!["BUY","SELL"].includes(r.decision)))return{sent:false,reason:"NO_SIGNAL"};
 const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
 if(!token||!chatId)return{sent:false,reason:"TELEGRAM_NOT_CONFIGURED"};
 const msg=[
 "🤖 AI XAUUSD ANALYSIS",
 symbol+" • "+r.decision,
 "",
 "📊 MARKET CONTEXT",
 "D1 Bias: "+(record.dailyBias??"—"),
 "D1: "+(r.dailyBiasReason||"—"),
 "H1 Structure: "+(record.h1Direction??"—"),
 "H1: "+(r.h1Reason||"—"),
 "M15: "+(r.m15Reason||"—"),
 "M5 Trigger: "+(r.m5Reason||"—"),
 "",
 "🧠 FUNDAMENTAL",
 r.fundamentalReason||"—",
 "",
 "🎯 TRADE PLAN",
 (r.decision==="NO_TRADE"?"WAIT / NO ENTRY":r.decision+" Entry: "+(r.entry??"—")),
 "SL: "+(r.stopLoss??"—"),
 "TP1: "+(r.takeProfit1??"—"),
 "TP2: "+(r.takeProfit2??"—"),
 "Confidence: "+(r.confidence??0)+"%",
 "Technical Score: "+(record.technicalScore??"—"),
 "Fundamental Score: "+(record.fundamentalScore??"—"),
 "Final Score: "+(record.weightedScore??"—"),
 "",
 r.decision==="NO_TRADE"?"📌 ALASAN WAIT":"📌 KENAPA ENTRY?",
 r.entryReason||r.technicalReason||"—",
 "",
 "❌ INVALIDATION",
 r.invalidation||"—",
 "",
 "Status: AI COMPLETED"
 ].join("\n");
 const resp=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:msg})});
 if(!resp.ok)throw new Error("Telegram HTTP "+resp.status);
 return{sent:true};
}
async function sendTelegramLifecycle(event){
 const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
 if(!token||!chatId)return {sent:false,reason:"TELEGRAM_NOT_CONFIGURED"};
 const status=event.event||event.status;
 const icon=status==="ACTIVE"?"🎯":status==="TP1"||status==="TP2"?"✅":status==="SL"?"❌":"⏳";
 const text=[icon+" XAUUSD RETEST "+status,"Side: "+event.side,"Entry: "+event.entry,"SL: "+event.stop_loss,"TP1: "+event.tp1,"TP2: "+event.tp2,status==="FAILED"?"Entry tidak tersentuh sebelum H1 berikutnya — tidak dihitung LOSS.":""].filter(Boolean).join("\n");
 const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});
 if(!r.ok)throw new Error("Telegram lifecycle HTTP "+r.status);
 return {sent:true,status}
}

const noTrade=reason=>({decision:"NO_TRADE",confidence:0,entry:null,stopLoss:null,takeProfit1:null,takeProfit2:null,technicalReason:reason,fundamentalReason:"Not evaluated because mandatory SMC gate failed",invalidation:""});
app.get("/health",async(req,res)=>{let persistedMt5=null,dbStatus="OFFLINE";try{dbStatus=await checkDb()?"ONLINE":"OFFLINE";persistedMt5=await getHeartbeat("MT5")}catch(e){console.error("heartbeat db read",e.message)}if(persistedMt5)lastMt5At=Math.max(lastMt5At,new Date(persistedMt5).getTime());let fundamentalHealth={status:"ERROR",coverageWeight:0};try{const f=await getFundamental();fundamentalHealth={status:f.status,coverageWeight:f.coverageWeight||0,dxy:f.dxy?"ONLINE":"OFFLINE",yield10y:f.yield10y?"ONLINE":"OFFLINE",calendar:f.calendar?.status==="LIVE"?"ONLINE":"OFFLINE",goldMacro:f.goldMacro?.status==="LIVE"?"ONLINE":"OFFLINE",updatedAt:f.updatedAt};}catch(e){fundamentalHealth.error=e.message;}let openaiStatus="OFFLINE";if(process.env.OPENAI_API_KEY){try{const r=await fetch("https://api.openai.com/v1/models",{headers:{Authorization:"Bearer "+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(5000)});openaiStatus=r.ok?"ONLINE":"OFFLINE";}catch{openaiStatus="OFFLINE";}}const age=lastMt5At?Date.now()-lastMt5At:null;const mt5Status=age!=null&&age<=7*60*1000?"ONLINE":"OFFLINE";const systemOnline=dbStatus==="ONLINE"&&mt5Status==="ONLINE";res.json({ok:systemOnline,service:"smc-scalping-ai",engine:"D1_BIAS_H1_M15_M5_SMC",bridgeAuth:!!process.env.BRIDGE_TOKEN,minTech,minFinal,connections:{backend:{status:"ONLINE"},database:{status:dbStatus},mt5:{status:mt5Status,lastSeenAt:lastMt5At?new Date(lastMt5At).toISOString():null,ageSeconds:age==null?null:Math.round(age/1000)},openai:{status:openaiStatus},fred:{status:fundamentalHealth.dxy==="ONLINE"&&fundamentalHealth.yield10y==="ONLINE"?"ONLINE":"OFFLINE"}},fundamental:fundamentalHealth});});
app.get("/api/trades/journal",async(req,res)=>{try{res.json(await getTradeJournal(String(req.query.symbol||"XAUUSD").toUpperCase(),req.query.period==="monthly"?"monthly":"daily",String(req.query.date||new Date().toISOString().slice(0,10))))}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/trades/stats",async(req,res)=>{try{res.json(await getTradeStats(String(req.query.symbol||"XAUUSD").toUpperCase()))}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/fundamental",async(req,res)=>{try{res.json(await getFundamental())}catch(e){res.status(503).json({status:"ERROR",error:e.message})}});
app.post("/api/mt5/heartbeat",bridgeAuth,async(req,res)=>{lastMt5At=Date.now();const key=String(req.body?.symbol||"XAUUSD").toUpperCase();const px=Number(req.body?.price??req.body?.bid??req.body?.last);if(Number.isFinite(px)){livePrice.set(key,{price:px,at:new Date().toISOString()});try{const events=await updateOpenTradesFromPrice(key,px);for(const ev of events){try{await sendTelegramLifecycle(ev)}catch(te){console.error("Telegram lifecycle failed",te.message)}}}catch(e){console.error("LIVE trade tracking/db write",e.message)}}let closedM5=(buffers.get(key)||[]).length;try{await touchHeartbeat("MT5");const n=await getCurrentM5Count(key);if(n!=null)closedM5=n}catch(e){console.error("heartbeat db",e.message)}const now=new Date(),expected=Math.floor(now.getUTCMinutes()/5);res.json({status:"ONLINE",serverTime:new Date(lastMt5At).toISOString(),closedM5,expectedClosedM5:expected,resyncRequired:closedM5<expected});});
app.get("/api/price",async(req,res)=>{const key=String(req.query.symbol||"XAUUSD").toUpperCase();let p=livePrice.get(key)||null;if(!p){try{const j=await getTradeJournal(key,"daily",new Date().toISOString().slice(0,10));const t=j?.trades?.at(-1);if(t)p={price:t.exit_price??t.entry,at:t.closed_at??t.signal_time,source:"LAST_SIGNAL"}}catch{}}res.json({symbol:key,...(p||{price:null,at:null}),source:p?.source||"MT5"});});
app.post("/api/telegram/test",bridgeAuth,async(req,res)=>{try{const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;if(!token||!chatId)return res.status(503).json({ok:false,error:"Telegram not configured"});const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:"✅ AI SMC Telegram TEST — koneksi berhasil. Ini bukan sinyal trading."})});const j=await r.json().catch(()=>({}));res.status(r.ok&&j.ok?200:502).json({ok:!!(r.ok&&j.ok),telegramHttp:r.status});}catch(e){res.status(502).json({ok:false,error:e.message})}});
app.get("/api/status",async(req,res)=>{const key=String(req.query.symbol||"XAUUSD").toUpperCase();let closedM5=(buffers.get(key)||[]).length;try{const n=await getCurrentM5Count(key);if(n!=null)closedM5=n}catch(e){console.error("M5 status db read",e.message)}const current=latest.get(key)||null;let activeTrade=null,latestTrade=null;try{activeTrade=await getLatestOpenTrade(key);latestTrade=await getLatestTrade(key)}catch(e){console.error("trade db read",e.message)}const mem=aiRuntime.get(key);const ar={state:mem?.state==="AI_COMPLETED"?"WAITING_H1_CLOSE":(mem?.state||"WAITING_H1_CLOSE"),aiCalled:!!latestTrade||!!mem?.aiCalled,lastAiAt:latestTrade?.signal_time||mem?.lastAiAt||null,lastDecision:latestTrade?.side||mem?.lastDecision||null};const hourly=!!latestTrade||current?.mode==="HOURLY_D1_MTF_ANALYSIS";res.json({symbol:key,activeTrade,latestTrade,engine:"D1_H1_M15_M5_HOURLY",trigger:"CLOSED_H1",monitor:{d1:"CONTEXT",h1:hourly?"ANALYZED":"WAITING_CLOSE",m15:hourly?"CONFIRMED":"WAITING_H1",m5:hourly?"EXECUTION_CHECKED":"WAITING_H1"},legacyM5:{closed:closedM5,required:12,ingestOnly:true},aiRuntime:ar,latest:current});});
async function run(symbol,candles,fundamental={},h1Context={}){if(!Number.isFinite(Number(fundamental.score)))fundamental=await getFundamental();const technical=analyzeSMC(candles,h1Context),side=technical.bullishScore>=technical.bearishScore?"BUY":"SELL",techScore=Math.max(technical.bullishScore,technical.bearishScore);const fundamentalMissing=!Number.isFinite(Number(fundamental.score)),fundamentalScore=fundamentalMissing?null:Number(fundamental.score),mandatory=side==="BUY"?technical.mandatoryBuy:technical.mandatorySell;let weightedScore=fundamentalScore==null?+(techScore*.7).toFixed(2):+(techScore*.7+fundamentalScore*.3).toFixed(2),result;if(!mandatory||techScore<minTech)result=noTrade(!mandatory?"Mandatory SMC setup incomplete":"Technical score below threshold");else if(fundamentalScore==null)result=noTrade("Fundamental snapshot missing");else if(weightedScore<minFinal)result=noTrade("Final weighted score below threshold");else{aiRuntime.set(symbol,{state:"AI_CALLED",aiCalled:true,lastAiAt:new Date().toISOString(),lastDecision:null});try{result=await aiDecision({symbol,timeframe:"M5",trigger:"H1_CLOSE_12_M5",weights:{technical:70,fundamental:30},technical,technicalScore:techScore,technicalDirection:side,fundamental:{...fundamental,score:fundamentalScore},weightedScore,candles});aiRuntime.set(symbol,{state:"AI_COMPLETED",aiCalled:true,lastAiAt:new Date().toISOString(),lastDecision:result.decision||null});}catch(e){aiRuntime.set(symbol,{state:"AI_ERROR",aiCalled:true,lastAiAt:new Date().toISOString(),lastDecision:null,error:e.message});throw e;}}if(!aiRuntime.get(symbol)?.aiCalled)aiRuntime.set(symbol,{state:"SMC_REJECTED",aiCalled:false,lastAiAt:aiRuntime.get(symbol)?.lastAiAt||null,lastDecision:result.decision||"NO_TRADE"});return{technicalScore:techScore,fundamentalScore,fundamentalStatus:fundamentalMissing?"MISSING":"LIVE_INPUT",weightedScore,technical,aiCalled:!!aiRuntime.get(symbol)?.aiCalled,result,analyzedAt:new Date().toISOString()};}
app.post("/api/m5/candle",bridgeAuth,async(req,res)=>{lastMt5At=Date.now();try{await touchHeartbeat("MT5").catch(e=>console.error("heartbeat db write",e.message));const{symbol="XAUUSD",candle,fundamental={},h1Context={}}=req.body;if(!candle?.time)return res.status(400).json({error:"candle.time required"});const key=symbol.toUpperCase(),t=new Date(candle.time);if(!Number.isFinite(t.getTime()))return res.status(400).json({error:"Invalid candle.time"});const minute=t.getUTCMinutes();if(minute%5!==0)return res.status(400).json({error:"Invalid M5 slot"});const hour=t.toISOString().slice(0,13),blockStart=new Date(t);blockStart.setUTCMinutes(0,0,0);try{await saveM5Candle(key,candle);await updateOpenTrades(key,candle)}catch(e){console.error("M5 trade tracking/db write",e.message)}let arr=[];try{arr=await getM5Block(key,blockStart)}catch(e){console.error("M5 db read",e.message);const old=buffers.get(key)||[];arr=old.filter(x=>new Date(x.time).toISOString().slice(0,13)===hour);if(!arr.some(x=>new Date(x.time).getTime()===t.getTime()))arr.push(candle)}arr.sort((a,b)=>new Date(a.time)-new Date(b.time));const slots=arr.map(x=>new Date(x.time).getUTCMinutes());const contiguous=slots.every((m,i)=>i===0||m===slots[i-1]+5);if(!contiguous){console.warn("Non-contiguous M5 block",key,slots);buffers.set(key,[candle]);return res.json({status:"COLLECTING",closedM5:1,required:12,hour,recovered:true});}buffers.set(key,arr);if(arr.length<12){const prev=aiRuntime.get(key)||{};aiRuntime.set(key,{...prev,state:"COLLECTING_M5",aiCalled:false,closedM5:arr.length});return res.json({status:"COLLECTING",closedM5:arr.length,required:12,hour});}const blockId=hour;if(lastSignal.get(key)===blockId)return res.json({status:"ALREADY_ANALYZED",blockId});const record={blockId,...await run(key,arr,fundamental,h1Context)};latest.set(key,record);lastSignal.set(key,blockId);buffers.set(key,[]);let telegram={sent:false};try{telegram=await sendTelegramSignal(key,record)}catch(e){telegram={sent:false,error:e.message};console.error("Telegram signal failed",e.message)}res.json({status:"ANALYZED",telegram,...record});}catch(e){res.status(400).json({error:e.message});}});
app.post("/api/mtf/analyze",bridgeAuth,async(req,res)=>{try{
 const {symbol="XAUUSD",previousD1,h1=[],m15=[],m5=[],fundamental={}}=req.body;
 const key=symbol.toUpperCase();
 if(!previousD1?.time)return res.status(400).json({error:"previousD1 closed candle required"});
 if(!Array.isArray(h1)||!Array.isArray(m15)||!Array.isArray(m5)||h1.length<2||m15.length<4||m5.length<12)return res.status(400).json({error:"MTF history insufficient",required:{h1:2,m15:4,m5:12}});
 const normalizeCandle=x=>{if(!x||typeof x!=="object")return null;const time=x.time??x.timestamp??x.datetime;return {...x,time,open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),closed:x.closed!==false}};
 const d1=normalizeCandle(previousD1),H1=h1.map(normalizeCandle),M15=m15.map(normalizeCandle),M5=m5.map(normalizeCandle);
 const valid=x=>x&&x.closed&&x.time!=null&&!Number.isNaN(new Date(x.time).getTime())&&[x.open,x.high,x.low,x.close].every(Number.isFinite);
 const bad={d1:valid(d1)?0:1,h1:H1.filter(x=>!valid(x)).length,m15:M15.filter(x=>!valid(x)).length,m5:M5.filter(x=>!valid(x)).length};
 if(bad.d1||bad.h1||bad.m15||bad.m5){console.error("MTF_INVALID_PAYLOAD",JSON.stringify({symbol:key,bad,lengths:{h1:H1.length,m15:M15.length,m5:M5.length}}));return res.status(400).json({error:"Invalid MTF candle payload",bad,lengths:{h1:H1.length,m15:M15.length,m5:M5.length}})}
 const h1Last=H1.at(-1),h1Prev=H1.at(-2);
 const h1CloseTime=new Date(h1Last.time);
 if(Number.isNaN(h1CloseTime.getTime()))return res.status(400).json({error:"Invalid last H1 time"});
 // Normalize the signal key/time to the CLOSED H1 candle slot, never to M5/request arrival time.
 const h1Slot=new Date(h1CloseTime);h1Slot.setUTCMinutes(0,0,0);
 const hourlyId=key+":"+h1Slot.toISOString();
 const expiredRows=await expirePendingTrades(key,h1Slot);
 for(const ev of expiredRows){try{await sendTelegramLifecycle({event:"FAILED",...ev})}catch(te){console.error("Telegram FAILED failed",te.message)}}
 const expired=expiredRows.length;
 if(lastSignal.get(key+":HOURLY")===hourlyId || await hasTradeSignal(hourlyId))return res.json({status:"ALREADY_ANALYZED",hourlyId,latest:latest.get(key)||null});
 const dailyBias=d1.close>d1.open?"BUY":d1.close<d1.open?"SELL":"NEUTRAL";
 const h1Direction=+h1Last.close>+h1Prev.high?"BUY":+h1Last.close<+h1Prev.low?"SELL":(+h1Last.close>=+h1Last.open?"BULLISH":"BEARISH");
 const technical=analyzeRollingM5(M5,{direction:h1Direction});
 const side=technical.bullishScore>=technical.bearishScore?"BUY":"SELL",techScore=Math.max(technical.bullishScore,technical.bearishScore);
 let fund=fundamental;if(!Number.isFinite(Number(fund.score)))fund=await getFundamental();
 const fundamentalScore=Number.isFinite(Number(fund.score))?Number(fund.score):null;
 const weightedScore=fundamentalScore==null?+(techScore*.7).toFixed(2):+(techScore*.7+fundamentalScore*.3).toFixed(2);
 const result=await aiDecision({symbol:key,mode:"HOURLY_D1_MTF_ANALYSIS",trigger:"CLOSED_H1",daily:{previousClosedD1:d1,bias:dailyBias},timeframes:{h1:H1.slice(-24),m15:M15.slice(-32),m5:M5.slice(-36)},structure:{h1Direction},technical,technicalScore:techScore,technicalDirection:side,fundamental:{...fund,score:fundamentalScore},weightedScore,thresholds:{minTechnical:minTech,minFinal},weights:{technical:70,fundamental:30},rule:"Analyze exactly once per newly closed H1 and always return one actionable directional entry signal: BUY or SELL. Never return NO_TRADE in HOURLY_D1_MTF_ANALYSIS. When evidence conflicts or is weak, select the stronger direction, lower confidence, and explain the weakness. Derive Entry, SL, TP1 and TP2 from supplied market structure."});
 if(["BUY","SELL"].includes(result.decision)&&[result.entry,result.stopLoss,result.takeProfit1,result.takeProfit2].every(v=>Number.isFinite(Number(v)))){
   const slPips=Math.abs(Number(result.entry)-Number(result.stopLoss))/0.10;
   if(slPips>=50&&slPips<=60){
     await saveTradeSignal({hourlyId,symbol:key,side:result.decision,entry:+result.entry,stopLoss:+result.stopLoss,tp1:+result.takeProfit1,tp2:+result.takeProfit2,confidence:+result.confidence||null,signalTime:h1Slot.toISOString()});
   }else{
     console.error("RETEST_SL_REJECTED",hourlyId,"SL pips",slPips.toFixed(1),"required 50-60");
     return res.status(422).json({error:"AI_SL_OUT_OF_RANGE",required:"50-60 pips",slPips:+slPips.toFixed(1),hourlyId});
   }
 }
 const record={mode:"HOURLY_D1_MTF_ANALYSIS",hourlyId,expiredPrevious:expired,dailyBias,h1Direction,technicalScore:techScore,fundamentalScore,weightedScore,result,analyzedAt:new Date().toISOString()};
 latest.set(key,record);lastSignal.set(key+":HOURLY",hourlyId);aiRuntime.set(key,{state:result.decision==="NO_TRADE"?"HOURLY_WAIT":"AI_COMPLETED",aiCalled:true,lastAiAt:new Date().toISOString(),lastDecision:result.decision});
 let telegram={sent:false};try{telegram=await sendTelegramSignal(key,record)}catch(e){telegram={sent:false,error:e.message};console.error("Hourly Telegram failed",e.message)}
 res.json({status:result.decision==="NO_TRADE"?"WAIT":"SIGNAL",telegram,...record});
}catch(e){console.error("MTF_ANALYZE_ERROR",e?.stack||e?.message||e);res.status(400).json({error:e.message})}});
app.post("/api/analyze",bridgeAuth,async(req,res)=>{try{const{symbol="XAUUSD",candles,fundamental={},h1Context={}}=req.body;const record=await run(symbol.toUpperCase(),candles,fundamental,h1Context);latest.set(symbol.toUpperCase(),record);res.json(record)}catch(e){res.status(400).json({error:e.message})}});
const port=process.env.PORT||3000;initDb().then(async()=>{await normalizeLegacyHourlySignals("XAUUSD");console.log("Database heartbeat ready")}).catch(e=>console.error("Database init failed",e.message));app.listen(port,()=>console.log("SMC AI listening on",port));