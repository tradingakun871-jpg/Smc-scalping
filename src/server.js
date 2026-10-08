import express from "express";
import crypto from "crypto";
import {analyzeSMC,analyzeRollingM5} from "./smc.js";
import {aiDecision,reviewTrade,reviewPendingSetup} from "./ai.js";
import {getFundamental} from "./fundamental.js";
import {initDb,checkDb,touchHeartbeat,getHeartbeat,saveM5Candle,getM5Block,getCurrentM5Count,saveMtfCandles,getHistoricalCandles,saveTradeSignal,updateOpenTrades,updateOpenTradesFromPrice,getTradeStats,getTradeJournal,getLatestOpenTrade,hasTradeSignal,hasHourlyAnalysis,saveHourlyAnalysis,normalizeLegacyHourlySignals,getLatestTrade,saveTradeLearningContext,saveTradeReview,getLearningMemory,getRollingLearningMemory,getLongTermLearningMemory,getCancelledLearningMemory,getTradesBetween,getLearningSummary,cancelPendingAtMarketClose,evaluatePendingSetups,resolvePendingSetupReview,updateCancelledShadowLearning,getCancelledShadowLearning,getLearningBaseline,getCancelledShadowBaseline} from "./db.js";
const app=express();app.use(express.json({limit:"1mb"}));app.use(express.static("public"));
const buffers=new Map(),lastSignal=new Map(),latest=new Map(),aiRuntime=new Map(),livePrice=new Map(),lastM5Ingest=new Map();let lastMt5At=0;
const minTech=Number(process.env.MIN_TECHNICAL_SCORE||70),minFinal=Number(process.env.MIN_FINAL_SCORE||70);
function bridgeAuth(req,res,next){const expected=process.env.BRIDGE_TOKEN;if(!expected)return res.status(503).json({error:"BRIDGE_TOKEN not configured"});const auth=req.get("authorization")||"";const token=auth.startsWith("Bearer ")?auth.slice(7):"";const a=Buffer.from(token),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:"Unauthorized bridge"});next();}


function calculateTargetProbabilities(record,result){
 const side=result?.decision;
 if(!["BUY","SELL"].includes(side))return result;
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const tech=Number(record.technicalScore), weighted=Number(record.weightedScore), conf=Number(result.confidence);
 let p=50; const reasons=[];
 if(Number.isFinite(tech)){p+=(tech-50)*0.30;reasons.push("technical score "+tech.toFixed(0)+"%");}
 if(Number.isFinite(weighted)){p+=(weighted-50)*0.20;reasons.push("final score "+weighted.toFixed(0)+"%");}
 if(Number.isFinite(conf)){p+=(conf-50)*0.20;reasons.push("AI confidence "+conf.toFixed(0)+"%");}
 if(record.dailyBias){const ok=record.dailyBias===side;p+=ok?6:-6;reasons.push("D1 "+(ok?"searah":"berlawanan"));}
 if(record.h1Direction){const ok=record.h1Direction===side||record.h1Direction===(side==="BUY"?"BULLISH":"BEARISH");p+=ok?8:-8;reasons.push("H1 "+(ok?"searah":"berlawanan"));}
 const tp1=Math.round(clamp(p,25,90));
 let penalty=12; const e=Number(result.entry),t1=Number(result.takeProfit1),t2=Number(result.takeProfit2);
 if([e,t1,t2].every(Number.isFinite)){const d1=Math.abs(t1-e),d2=Math.abs(t2-e);if(d1>0)penalty+=Math.max(0,Math.min(15,(d2/d1-1)*8));}
 const tp2=Math.round(clamp(tp1-penalty,15,tp1));
 result.tp1ProbabilityPct=tp1;result.tp2ProbabilityPct=tp2;
 result.probabilityReason="Estimasi berbasis "+reasons.join(", ")+"; TP2 lebih rendah karena target lebih jauh. Bukan jaminan hasil.";
 return result;
}

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
 "TP1 Probability: "+(r.tp1ProbabilityPct??"—")+"%",
 "TP2 Probability: "+(r.tp2ProbabilityPct??"—")+"%",
 "Reason Probabilitas: "+(r.probabilityReason||"—"),
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
async function sendTelegramLifecycle(symbol,t,review=null){
 const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
 if(!token||!chatId)return{sent:false,reason:"TELEGRAM_NOT_CONFIGURED"};
 const status=String(t?.status||t?.lifecycle_status||"REVIEW");
 const labels={ENTRY_TOUCHED:"✅ ENTRY VALID / ACTIVE",SETUP_VALID:"✅ SETUP VALID / DIPERTAHANKAN",CANCELLED:"❌ ENTRY CANCELLED",TP1_REACHED:"🟢 REVIEW TP1 REACHED",TP1:"🟢 REVIEW TP1",TP2:"🏆 REVIEW TP2",SL:"🔴 REVIEW SL"};
 const lines=["🔄 AI TRADE REVIEW UPDATE",symbol+" • "+(t?.side||"—"),"",labels[status]||("Status: "+status),"Signal: "+(t?.hourly_id||"—"),"Entry: "+(t?.entry??"—"),"SL: "+(t?.stop_loss??"—"),"TP1: "+(t?.tp1??"—"),"TP2: "+(t?.tp2??"—")];
 if(t?.lifecycle_reason)lines.push("Lifecycle: "+t.lifecycle_reason);
 if(review){lines.push("","🧠 AI REVIEW","Regime: "+(review.marketRegime||"—"),"Method: "+(review.strategyUsed||"—"),"Cause: "+(review.primaryCause||"—"),"Lesson: "+(review.lesson||"—"));}
 if(status==="CANCELLED")lines.push("","Catatan: dibatalkan sebelum entry; tidak dihitung WIN/LOSS.");
 if(status==="ENTRY_TOUCHED")lines.push("","Catatan: harga menyentuh entry; setup menjadi ACTIVE. Ini belum WIN/LOSS.");if(status==="TP1_REACHED")lines.push("","Catatan: TP1 tercapai; proteksi tracker berpindah ke BE (harga entry) sambil menunggu TP2 atau retrace BE.");if(status==="SETUP_VALID")lines.push("","Catatan: target sempat terlewati sebelum entry, tetapi AI menilai setup masih fresh, valid, reachable, dan probability masih tinggi. Level asli tetap digunakan.");
 const resp=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:lines.join("\n")})});
 if(!resp.ok)throw new Error("Telegram lifecycle HTTP "+resp.status);
 return{sent:true};
}
async function handlePendingSetupEvents(symbol,events=[]){
 for(const t of events){
  if(t?.status==="CANCELLED"){
   await saveTradeReview(t.hourly_id,"CANCELLED",0,{reviewStage:"PENDING_FINAL",primaryCause:t.lifecycle_reason,lesson:t.lifecycle_reason==="MARKET_CLOSED_PENDING_CANCELLED"?"Setup masih pending saat market close sehingga dibatalkan. Gunakan sebagai quality-learning untuk menilai reachability/timing; tidak dihitung WIN/LOSS.":"Setup belum entry dan dibatalkan karena expiry/invalidation. Tidak dihitung WIN/LOSS."}).catch(()=>{});
   console.log("PENDING_SETUP_CANCELLED",symbol,t.hourly_id,t.lifecycle_reason);
   try{await sendTelegramLifecycle(symbol,t)}catch(te){console.error("Telegram cancel update failed",te.message)}
   continue;
  }
  if(t?.status!=="REVIEW_REQUIRED")continue;
  try{
   const now=new Date(),blockStart=new Date();blockStart.setUTCMinutes(0,0,0);
   const [histH1,histM15,histM5,currentM5,memory]=await Promise.all([
    getHistoricalCandles(symbol,"H1",now,3,72).catch(()=>[]),
    getHistoricalCandles(symbol,"M15",now,3,288).catch(()=>[]),
    getHistoricalCandles(symbol,"M5",now,3,864).catch(()=>[]),
    getM5Block(symbol,blockStart).catch(()=>[]),
    getLearningMemory(symbol,100).catch(()=>[])
   ]);
   const prior=memory.find(x=>x.hourly_id===t.hourly_id);
   const compact=(arr,n)=>arr.slice(-n).map(x=>[x.time,x.open,x.high,x.low,x.close]);
   const aiReview=await reviewPendingSetup({
    symbol,
    hourlyId:t.hourly_id,
    side:t.side,
    original:{entry:+t.entry,stopLoss:+t.stop_loss,tp1:+t.tp1,tp2:+t.tp2,confidence:t.confidence,signalTime:t.signal_time},
    currentPrice:Number(t.review_price),
    signalContext:prior?.context||{},
    currentMarket:{
     h1:compact(histH1,36),
     m15:compact(histM15,64),
     m5:compact(histM5,96),
     currentM5Block:compact(currentM5,12)
    },
    policy:{keepProbabilityMin:70,levelsMustRemainUnchanged:true,requireFresh:true,requireStructuralValid:true,requireReachable:true}
   });
   const probability=Math.max(0,Math.min(100,Number(aiReview?.probability)||0));
   const keep=String(aiReview?.decision||"").toUpperCase()==="KEEP" && probability>=70 && aiReview?.fresh===true && aiReview?.structuralValid===true && aiReview?.reachable===true;
   const resolved=await resolvePendingSetupReview(t.hourly_id,keep?"KEEP":"CANCEL",{probability,reason:aiReview?.reason||aiReview?.invalidationRisk||"STALE_OR_LOW_PROBABILITY"});
   if(keep){
    console.log("PENDING_SETUP_RETAINED",symbol,t.hourly_id,JSON.stringify({probability:+probability.toFixed(1),fresh:aiReview.fresh,structuralValid:aiReview.structuralValid,reachable:aiReview.reachable,regime:aiReview.marketRegime,reason:aiReview.reason}));
    try{await sendTelegramLifecycle(symbol,{...resolved,status:"SETUP_VALID"},aiReview)}catch(te){console.error("Telegram pending-valid update failed",te.message)}
   }else{
    const cancelled={...resolved,status:"CANCELLED"};
    await saveTradeReview(t.hourly_id,"CANCELLED",0,{...aiReview,reviewStage:"TARGET_PASSED_PENDING_FINAL",primaryCause:"TARGET_PASSED_AI_CANCELLED",lesson:"Target sudah terlewati sebelum entry dan AI menilai setup tidak lagi fresh/valid/reachable atau probability di bawah 70%. Tidak dihitung WIN/LOSS."}).catch(()=>{});
    console.log("PENDING_SETUP_AI_CANCELLED",symbol,t.hourly_id,JSON.stringify({probability:+probability.toFixed(1),fresh:aiReview?.fresh,structuralValid:aiReview?.structuralValid,reachable:aiReview?.reachable,regime:aiReview?.marketRegime,reason:aiReview?.reason}));
    try{await sendTelegramLifecycle(symbol,cancelled,aiReview)}catch(te){console.error("Telegram pending-cancel update failed",te.message)}
   }
  }catch(e){
   console.error("PENDING_SETUP_AI_REVIEW_ERROR",symbol,t?.hourly_id,e.message);
   // Fail safe: keep it in REVIEW_REQUIRED so the next heartbeat can retry;
   // never silently reactivate a target-passed setup when AI review failed.
  }
 }
}

async function learnFromClosedTrades(symbol,events=[]){
 for(const t of events){
  if(!["TP1_REACHED","TP1","TP2","SL"].includes(t?.status))continue;
  try{
   const memory=await getLearningMemory(symbol,100);
   const prior=memory.find(x=>x.hourly_id===t.hourly_id);
   if(prior?.reviewed_at && t.status==="TP1_REACHED")continue;
   const historyEnd=t?.closed_at?new Date(t.closed_at):new Date();
   const [histH1,histM15,histM5]=await Promise.all([
    getHistoricalCandles(symbol,"H1",historyEnd,3,72).catch(()=>[]),
    getHistoricalCandles(symbol,"M15",historyEnd,3,288).catch(()=>[]),
    getHistoricalCandles(symbol,"M5",historyEnd,3,864).catch(()=>[])
   ]);
   const compactCandles=(arr,n)=>arr.slice(-n).map(x=>[x.time,x.open,x.high,x.low,x.close]);
   const historicalCandles={windowDays:3,available:{h1:histH1.length,m15:histM15.length,m5:histM5.length},used:{h1:compactCandles(histH1,48),m15:compactCandles(histM15,96),m5:compactCandles(histM5,144)},instruction:"Use historical candles only when they materially help explain the trade outcome. Compare pre-entry structure/regime, extension, support/resistance, sweep/displacement and follow-through. Do not overfit one trade."};
   console.log("LEARNING_HISTORY_CONTEXT",symbol,t.hourly_id,JSON.stringify(historicalCandles.available));
   const review=await reviewTrade({symbol,hourlyId:t.hourly_id,side:t.side,entry:+t.entry,stopLoss:+t.stop_loss,tp1:+t.tp1,tp2:+t.tp2,confidence:t.confidence,status:t.status,pnlPoints:+t.pnl_points||0,signalContext:prior?.context||{},savedRegime:prior?.regime||null,savedStrategy:prior?.strategy||null,historicalCandles});
   await saveTradeReview(t.hourly_id,t.status,+t.pnl_points||0,{...review,reviewStage:t.status==="TP1_REACHED"?"TP1_INTERMEDIATE":"FINAL"});
   console.log("TRADE_LEARNING_REVIEWED",symbol,t.hourly_id,t.status,JSON.stringify({regime:review.marketRegime,strategy:review.strategyUsed,cause:review.primaryCause,lesson:review.lesson}));try{await sendTelegramLifecycle(symbol,t,review)}catch(te){console.error("Telegram review update failed",te.message)}
  }catch(e){console.error("TRADE_LEARNING_REVIEW_ERROR",symbol,t?.hourly_id,e.message)}
 }
}
const noTrade=reason=>({decision:"NO_TRADE",confidence:0,entry:null,stopLoss:null,takeProfit1:null,takeProfit2:null,technicalReason:reason,fundamentalReason:"Not evaluated because mandatory SMC gate failed",invalidation:""});
function enforceWeb1Blueprint(result){
 if(!result||typeof result!=="object")return noTrade("AI result invalid");
 const side=String(result.decision||"NO_TRADE").toUpperCase();
 if(!["BUY","SELL"].includes(side))return result;
 const entry=Number(result.entry),sl=Number(result.stopLoss);
 const reject=reason=>({...result,decision:"NO_TRADE",confidence:Math.max(0,Math.min(100,Number(result.confidence)||0)),entry:null,stopLoss:null,takeProfit1:null,takeProfit2:null,entryReason:"Hard risk guard: "+reason,technicalReason:"Hard risk guard: "+reason,invalidation:reason,riskGuardRejected:true});
 if(!Number.isFinite(entry)||!Number.isFinite(sl))return reject("Entry/SL tidak valid");
 const risk=side==="BUY"?entry-sl:sl-entry;
 if(!(risk>0))return reject("Posisi SL berada di sisi yang salah");
 if(risk<3.5-1e-9||risk>6.0+1e-9)return reject("Jarak SL wajib 35-60 pips");
 const tp1=side==="BUY"?entry+risk:entry-risk;
 const tp2=side==="BUY"?entry+2*risk:entry-2*risk;
 return {...result,decision:side,confidence:Math.max(0,Math.min(100,Number(result.confidence)||0)),entry:+entry.toFixed(3),stopLoss:+sl.toFixed(3),takeProfit1:+tp1.toFixed(3),takeProfit2:+tp2.toFixed(3),riskPips:+(risk*10).toFixed(1),riskGuardValidated:true};
}
function buildAdaptiveProfile(memory=[]){
 const final=memory.filter(x=>["TP1","TP2","SL"].includes(x?.outcome));
 const byStrategy={},byPattern={};
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 let grossProfit=0,grossLoss=0,weightedGrossProfit=0,weightedGrossLoss=0,netPnl=0,weightedNetPnl=0,netR=0,weightedNetR=0,zeroPnlWins=0;
 for(const x of final){
  const s=String(x.strategy||x.review?.strategyUsed||"UNKNOWN");
  const regime=String(x.regime||x.review?.marketRegime||"UNKNOWN");
  const side=String(x.side||x.context?.side||"UNKNOWN");
  const w=Math.max(0.05,Number(x.learningWeight)||1);
  const win=["TP1","TP2"].includes(x.outcome);
  const loss=x.outcome==="SL";
  const pnl=Number(x.pnl_points)||0;
  const risk=Math.abs(Number(x.entry)-Number(x.stop_loss));
  const rMultiple=Number.isFinite(risk)&&risk>0?pnl/risk:0;
  if(pnl>0){grossProfit+=pnl;weightedGrossProfit+=pnl*w}
  if(pnl<0){grossLoss+=Math.abs(pnl);weightedGrossLoss+=Math.abs(pnl)*w}
  netPnl+=pnl;weightedNetPnl+=pnl*w;netR+=rMultiple;weightedNetR+=rMultiple*w;
  if(win&&pnl===0)zeroPnlWins++;

  const z=byStrategy[s]||(byStrategy[s]={samples:0,effectiveSamples:0,wins:0,losses:0,weightedWins:0,weightedLosses:0,pnlPoints:0,weightedPnlPoints:0});
  z.samples++;z.effectiveSamples+=w;
  if(win){z.wins++;z.weightedWins+=w}
  if(loss){z.losses++;z.weightedLosses+=w}
  z.pnlPoints+=pnl;z.weightedPnlPoints+=pnl*w;

  const key=[s,regime,side].join("|");
  const p=byPattern[key]||(byPattern[key]={strategy:s,regime,side,samples:0,effectiveSamples:0,wins:0,losses:0,weightedWins:0,weightedLosses:0,weightedPnlPoints:0,weightedR:0,weightedRiskPips:0,weightedConfidence:0});
  p.samples++;p.effectiveSamples+=w;
  if(win){p.wins++;p.weightedWins+=w}
  if(loss){p.losses++;p.weightedLosses+=w}
  p.weightedPnlPoints+=pnl*w;
  p.weightedR+=rMultiple*w;
  if(Number.isFinite(risk))p.weightedRiskPips+=(risk*10)*w;
  if(Number.isFinite(Number(x.confidence)))p.weightedConfidence+=Number(x.confidence)*w;
 }
 const strategyAdjustments={};
 for(const [s,z] of Object.entries(byStrategy)){
  const denom=z.weightedWins+z.weightedLosses;
  const wr=denom?z.weightedWins/denom:0.5;
  const enough=z.samples>=5;
  strategyAdjustments[s]={...z,effectiveSamples:+z.effectiveSamples.toFixed(2),weightedPnlPoints:+z.weightedPnlPoints.toFixed(3),winRatePct:+(wr*100).toFixed(1),confidenceAdjustment:enough?(wr>=0.65?5:wr<0.45?-8:0):0,action:!enough?"OBSERVE":wr>=0.65?"PREFER":wr<0.45?"DEPRIORITIZE":"NEUTRAL"};
 }
 const bestEntryPatterns=Object.values(byPattern).map(p=>{
  const denom=p.weightedWins+p.weightedLosses;
  const wr=denom?p.weightedWins/denom:0.5;
  const eff=Math.max(0.01,p.effectiveSamples);
  const avgR=p.weightedR/eff;
  const expectancyPoints=p.weightedPnlPoints/eff;
  const reliability=Math.min(1,p.samples/8);
  const rScore=clamp((avgR+1)/3,0,1);
  const score=50*(1-reliability)+reliability*((wr*70)+(rScore*30));
  const sampleStatus=p.samples>=5?"VALIDATED":p.samples>=3?"DEVELOPING":"OBSERVE";
  return {...p,effectiveSamples:+p.effectiveSamples.toFixed(2),winRatePct:+(wr*100).toFixed(1),avgR:+avgR.toFixed(3),expectancyPoints:+expectancyPoints.toFixed(3),avgRiskPips:+(p.weightedRiskPips/eff).toFixed(1),avgConfidence:+(p.weightedConfidence/eff).toFixed(1),score:+score.toFixed(1),sampleStatus};
 }).sort((a,b)=>b.score-a.score||b.samples-a.samples);
 const validated=bestEntryPatterns.filter(x=>x.sampleStatus==="VALIDATED"&&x.expectancyPoints>0);

 const chronological=[...final].sort((x,y)=>new Date(x.closed_at||x.reviewed_at||x.created_at)-new Date(y.closed_at||y.reviewed_at||y.created_at));
 let equity=0,peak=0,maxDrawdownPoints=0;
 for(const x of chronological){equity+=Number(x.pnl_points)||0;peak=Math.max(peak,equity);maxDrawdownPoints=Math.max(maxDrawdownPoints,peak-equity)}
 const wins=final.filter(x=>["TP1","TP2"].includes(x.outcome)).length;
 const losses=final.filter(x=>x.outcome==="SL").length;
 const effective=final.reduce((s,x)=>s+Math.max(0.05,Number(x.learningWeight)||1),0);
 const weightedWins=final.filter(x=>["TP1","TP2"].includes(x.outcome)).reduce((s,x)=>s+Math.max(0.05,Number(x.learningWeight)||1),0);
 const weightedLosses=final.filter(x=>x.outcome==="SL").reduce((s,x)=>s+Math.max(0.05,Number(x.learningWeight)||1),0);
 const performance={
  samples:final.length,wins,losses,
  winRatePct:(wins+losses)?+(wins*100/(wins+losses)).toFixed(1):0,
  weightedWinRatePct:(weightedWins+weightedLosses)?+(weightedWins*100/(weightedWins+weightedLosses)).toFixed(1):0,
  profitFactor:grossLoss>0?+(grossProfit/grossLoss).toFixed(3):null,
  weightedProfitFactor:weightedGrossLoss>0?+(weightedGrossProfit/weightedGrossLoss).toFixed(3):null,
  netPnlPoints:+netPnl.toFixed(3),weightedNetPnlPoints:+weightedNetPnl.toFixed(3),
  netR:+netR.toFixed(3),weightedNetR:+weightedNetR.toFixed(3),
  expectancyPoints:final.length?+(netPnl/final.length).toFixed(3):0,
  weightedExpectancyPoints:effective?+(weightedNetPnl/effective).toFixed(3):0,
  maxDrawdownPoints:+maxDrawdownPoints.toFixed(3),
  dataQuality:{zeroPnlWins},
  objective:"Improve WR, PF, PnL/Net-R and expectancy together while keeping drawdown/risk controlled. PF > 2.5 is a target, not a guarantee."
 };

 const normalizeList=v=>Array.isArray(v)?v.filter(Boolean).slice(0,5):(v?[String(v)]:[]);
 const compactLesson=x=>({
  hourlyId:x.hourly_id||x.hourlyId,
  strategy:String(x.strategy||x.review?.strategyUsed||"UNKNOWN"),
  regime:String(x.regime||x.review?.marketRegime||"UNKNOWN"),
  side:String(x.side||x.context?.side||"UNKNOWN"),
  outcome:x.outcome,
  factors:normalizeList(["TP1","TP2"].includes(x.outcome)?(x.review?.successFactors||x.review?.whatWorked):(x.review?.failureFactors||x.review?.whatFailed)),
  rule:["TP1","TP2"].includes(x.outcome)?(x.review?.reinforceRule||x.review?.nextTimeAdjustment||x.review?.lesson):(x.review?.avoidRule||x.review?.nextTimeAdjustment||x.review?.lesson),
  cause:x.review?.primaryCause||null
 });
 const reinforcedWinRules=final.filter(x=>["TP1","TP2"].includes(x.outcome)).slice(0,8).map(compactLesson);
 const lossCorrections=final.filter(x=>x.outcome==="SL").slice(0,8).map(compactLesson);
 const learningActions={
  reinforcedWinRules,
  lossCorrections,
  instruction:"WIN: identify and reinforce repeatable conditions only when repeated evidence and live structure support them. LOSS: diagnose the cause, correct/avoid the failed condition, and require stronger evidence before repeating it. Do not blindly repeat wins or reverse after losses. Optimize WR+PF+PnL/Net-R+expectancy jointly with controlled drawdown."
 };

 const n=final.length;
 const checkpoint=n>=200?200:n>=100?100:n>=50?50:n>=20?20:0;
 const nextCheckpoint=n<20?20:n<50?50:n<100?100:n<200?200:null;
 return {finalSamples:n,checkpoint,nextCheckpoint,historyWindowDays:7,timeDecay:"half-life-2d",regimeAware:true,performance,learningActions,strategyAdjustments,bestEntryPatterns:bestEntryPatterns.slice(0,8),bestEntryConclusion:validated.length?{status:"AVAILABLE",best:validated[0],alternatives:validated.slice(1,3),rule:"Prefer historically strong patterns only when current live structure is also valid. Historical rank never overrides structure or risk guardrails."}:{status:"INSUFFICIENT_VALIDATED_SAMPLE",rule:"Keep collecting finalized trades. Do not declare a best entry from small samples."},rule:"Continuous learning uses finalized trades from today first and can extend through the previous 7 days. Winners reinforce repeatable valid conditions; losses create corrections/avoid evidence. Newer outcomes have higher time-decay weight and matching regimes receive extra weight. Historical entry ranking compares strategy + regime + side using weighted win rate, expectancy/R and sample reliability. Checkpoints 20/50/100/200 control adaptation confidence. PENDING/CANCELLED never affect winrate/PF. Never override structural safety, Web1 SL 35-60 pips, TP1=1R, TP2=2R, or one-signal-per-H1."};
}
function buildCancelledLearningProfile(rows=[]){
 const reasons={},strategies={},regimes={};
 const recent=[];
 for(const x of rows){
  const reason=String(x.lifecycle_reason||x.review?.primaryCause||"CANCELLED_UNKNOWN");
  const strategy=String(x.strategy||x.review?.strategyUsed||"UNKNOWN");
  const regime=String(x.regime||x.review?.marketRegime||"UNKNOWN");
  reasons[reason]=(reasons[reason]||0)+1;
  strategies[strategy]=(strategies[strategy]||0)+1;
  regimes[regime]=(regimes[regime]||0)+1;
  if(recent.length<16)recent.push({
   hourlyId:x.hourly_id,side:x.side,strategy,regime,reason,
   probability:Number.isFinite(Number(x.review?.probability))?Number(x.review.probability):null,
   fresh:x.review?.fresh,
   structuralValid:x.review?.structuralValid,
   reachable:x.review?.reachable,
   lesson:x.review?.lesson||x.review?.reason||null,
   signalContext:x.context||null
  });
 }
 const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({name,count}));
 return{
  samples:rows.length,
  topCancellationReasons:top(reasons),
  strategies:top(strategies),
  regimes:top(regimes),
  recentCancelledSetups:recent,
  instruction:"CANCELLED setups are setup-quality evidence, not performance outcomes. Use them to avoid stale/mitigated POI, unreachable entries, pre-entry structural invalidation, expiry and target-passed low-probability conditions. They MUST NOT count as WIN/LOSS or alter WR/PF/PnL."
 };
}

app.get("/health",async(req,res)=>{let persistedMt5=null,dbStatus="OFFLINE";try{dbStatus=await checkDb()?"ONLINE":"OFFLINE";persistedMt5=await getHeartbeat("MT5")}catch(e){console.error("heartbeat db read",e.message)}if(persistedMt5)lastMt5At=Math.max(lastMt5At,new Date(persistedMt5).getTime());let fundamentalHealth={status:"ERROR",coverageWeight:0};try{const f=await getFundamental();fundamentalHealth={status:f.status,coverageWeight:f.coverageWeight||0,dxy:f.dxy?"ONLINE":"OFFLINE",yield10y:f.yield10y?"ONLINE":"OFFLINE",calendar:f.calendar?.status==="LIVE"?"ONLINE":"OFFLINE",goldMacro:f.goldMacro?.status==="LIVE"?"ONLINE":"OFFLINE",updatedAt:f.updatedAt};}catch(e){fundamentalHealth.error=e.message;}let openaiStatus="OFFLINE";if(process.env.OPENAI_API_KEY){try{const r=await fetch("https://api.openai.com/v1/models",{headers:{Authorization:"Bearer "+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(5000)});openaiStatus=r.ok?"ONLINE":"OFFLINE";}catch{openaiStatus="OFFLINE";}}const age=lastMt5At?Date.now()-lastMt5At:null;const mt5Status=age!=null&&age<=7*60*1000?"ONLINE":"OFFLINE";const systemOnline=dbStatus==="ONLINE"&&mt5Status==="ONLINE";res.json({ok:systemOnline,service:"smc-scalping-ai",engine:"D1_BIAS_H1_M15_M5_SMC",bridgeAuth:!!process.env.BRIDGE_TOKEN,minTech,minFinal,connections:{backend:{status:"ONLINE"},database:{status:dbStatus},mt5:{status:mt5Status,lastSeenAt:lastMt5At?new Date(lastMt5At).toISOString():null,ageSeconds:age==null?null:Math.round(age/1000)},openai:{status:openaiStatus},fred:{status:fundamentalHealth.dxy==="ONLINE"&&fundamentalHealth.yield10y==="ONLINE"?"ONLINE":"OFFLINE"}},fundamental:fundamentalHealth});});
app.post("/api/learning/bootstrap-4d",bridgeAuth,async(req,res)=>{try{
 const symbol=String(req.body?.symbol||"XAUUSD").toUpperCase();
 const trades=await getTradesBetween(symbol,"2026-09-29T00:00:00Z","2026-10-03T00:00:00Z");
 let reviewed=0,skipped=0;
 for(const t of trades){
  const outcome=t.status==="TP2"?"TP2":t.status==="TP1"?"TP1":t.status==="SL"?"SL":null;
  if(!outcome){skipped++;continue}
  await saveTradeLearningContext({hourlyId:t.hourly_id,symbol,regime:"HISTORICAL_PENDING_CLASSIFICATION",strategy:"HISTORICAL",context:{bootstrap:true,signalTime:t.signal_time,side:t.side,entry:+t.entry,stopLoss:+t.stop_loss,tp1:+t.tp1,tp2:+t.tp2,confidence:t.confidence,tp1Touched:!!t.tp1_touched}});
  try{
   const review=await reviewTrade({period:"2026-09-29..2026-10-02",symbol,hourlyId:t.hourly_id,side:t.side,entry:+t.entry,stopLoss:+t.stop_loss,tp1:+t.tp1,tp2:+t.tp2,confidence:t.confidence,outcome,pnlPoints:+t.pnl_points||0,signalTime:t.signal_time,rule:"Gunakan hanya outcome final TP1/TP2/SL untuk bootstrap performance. TP1_REACHED adalah intermediate dan bukan sampel final."});
   await saveTradeLearningContext({hourlyId:t.hourly_id,symbol,regime:review.marketRegime||"UNKNOWN",strategy:review.strategyUsed||"UNKNOWN",context:{bootstrap:true,signalTime:t.signal_time,side:t.side,entry:+t.entry,stopLoss:+t.stop_loss,tp1:+t.tp1,tp2:+t.tp2,confidence:t.confidence,tp1Touched:!!t.tp1_touched}});
   await saveTradeReview(t.hourly_id,outcome,+t.pnl_points||0,{...review,reviewStage:"FOUR_DAY_BOOTSTRAP"});reviewed++;
  }catch(e){console.error("BOOTSTRAP_REVIEW_ERROR",t.hourly_id,e.message)}
 }
 res.json({ok:true,period:"2026-09-29..2026-10-02",trades:trades.length,reviewed,skipped,summary:await getLearningSummary(symbol)});
}catch(e){res.status(500).json({ok:false,error:e.message})}});
app.get("/api/learning/summary",async(req,res)=>{try{const symbol=String(req.query.symbol||"XAUUSD").toUpperCase();res.json({symbol,summary:await getLearningSummary(symbol)})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/trades/journal",async(req,res)=>{try{const wibDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());res.json(await getTradeJournal(String(req.query.symbol||"XAUUSD").toUpperCase(),req.query.period==="monthly"?"monthly":"daily",String(req.query.date||wibDate)))}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/trades/stats",async(req,res)=>{try{res.json(await getTradeStats(String(req.query.symbol||"XAUUSD").toUpperCase()))}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/fundamental",async(req,res)=>{try{res.json(await getFundamental())}catch(e){res.status(503).json({status:"ERROR",error:e.message})}});
app.post("/api/mt5/heartbeat",bridgeAuth,async(req,res)=>{lastMt5At=Date.now();const key=String(req.body?.symbol||"XAUUSD").toUpperCase();const px=Number(req.body?.price??req.body?.bid??req.body?.last);if(Number.isFinite(px)){livePrice.set(key,{price:px,at:new Date().toISOString()});try{const pendingEvents=await evaluatePendingSetups(key,px);await handlePendingSetupEvents(key,pendingEvents);const tradeEvents=await updateOpenTradesFromPrice(key,px);await handlePendingSetupEvents(key,tradeEvents.filter(x=>x?.status==="CANCELLED"));for(const t of tradeEvents.filter(x=>x?.status==="ENTRY_TOUCHED")){try{await sendTelegramLifecycle(key,t)}catch(te){console.error("Telegram entry update failed",te.message)}}await learnFromClosedTrades(key,tradeEvents);}catch(e){console.error("LIVE trade tracking/db write",e.message)}}let closedM5=(buffers.get(key)||[]).length;try{await touchHeartbeat("MT5");const n=await getCurrentM5Count(key);if(n!=null)closedM5=n}catch(e){console.error("heartbeat db",e.message)}const now=new Date(),expected=Math.floor(now.getUTCMinutes()/5);res.json({status:"ONLINE",serverTime:new Date(lastMt5At).toISOString(),closedM5,expectedClosedM5:expected,resyncRequired:closedM5<expected});});
app.get("/api/price",async(req,res)=>{const key=String(req.query.symbol||"XAUUSD").toUpperCase();let p=livePrice.get(key)||null;if(!p){try{const wibDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());const j=await getTradeJournal(key,"daily",wibDate);const t=j?.trades?.at(-1);if(t)p={price:t.exit_price??t.entry,at:t.closed_at??t.signal_time,source:"LAST_SIGNAL"}}catch{}}res.json({symbol:key,...(p||{price:null,at:null}),source:p?.source||"MT5"});});
app.post("/api/telegram/test",bridgeAuth,async(req,res)=>{try{const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;if(!token||!chatId)return res.status(503).json({ok:false,error:"Telegram not configured"});const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:"✅ AI SMC Telegram TEST — koneksi berhasil. Ini bukan sinyal trading."})});const j=await r.json().catch(()=>({}));res.status(r.ok&&j.ok?200:502).json({ok:!!(r.ok&&j.ok),telegramHttp:r.status});}catch(e){res.status(502).json({ok:false,error:e.message})}});
app.get("/api/status",async(req,res)=>{const key=String(req.query.symbol||"XAUUSD").toUpperCase();let closedM5=(buffers.get(key)||[]).length;try{const n=await getCurrentM5Count(key);if(n!=null)closedM5=n}catch(e){console.error("M5 status db read",e.message)}const current=latest.get(key)||null;let activeTrade=null,latestTrade=null;try{activeTrade=await getLatestOpenTrade(key);latestTrade=await getLatestTrade(key)}catch(e){console.error("trade db read",e.message)}const mem=aiRuntime.get(key);const ar={state:mem?.state==="AI_COMPLETED"?"WAITING_H1_CLOSE":(mem?.state||"WAITING_H1_CLOSE"),aiCalled:!!mem?.aiCalled||!!latestTrade,lastAiAt:mem?.lastAiAt||latestTrade?.signal_time||null,lastDecision:mem?.lastDecision||latestTrade?.side||null};const hourly=!!latestTrade||current?.mode==="HOURLY_D1_MTF_ANALYSIS";res.json({symbol:key,activeTrade,latestTrade,engine:"D1_H1_M15_M5_HOURLY",trigger:"CLOSED_H1",monitor:{d1:"CONTEXT",h1:hourly?"ANALYZED":"WAITING_CLOSE",m15:hourly?"CONFIRMED":"WAITING_H1",m5:hourly?"EXECUTION_CHECKED":"WAITING_H1"},legacyM5:{closed:closedM5,required:12,ingestOnly:true},aiRuntime:ar,latest:current});});
async function run(symbol,candles,fundamental={},h1Context={}){if(!Number.isFinite(Number(fundamental.score)))fundamental=await getFundamental();const technical=analyzeSMC(candles,h1Context),side=technical.bullishScore>=technical.bearishScore?"BUY":"SELL",techScore=Math.max(technical.bullishScore,technical.bearishScore);const fundamentalMissing=!Number.isFinite(Number(fundamental.score)),fundamentalScore=fundamentalMissing?null:Number(fundamental.score),mandatory=side==="BUY"?technical.mandatoryBuy:technical.mandatorySell;let weightedScore=fundamentalScore==null?+(techScore*.7).toFixed(2):+(techScore*.7+fundamentalScore*.3).toFixed(2),result;if(!mandatory||techScore<minTech)result=noTrade(!mandatory?"Mandatory SMC setup incomplete":"Technical score below threshold");else if(fundamentalScore==null)result=noTrade("Fundamental snapshot missing");else if(weightedScore<minFinal)result=noTrade("Final weighted score below threshold");else{aiRuntime.set(symbol,{state:"AI_CALLED",aiCalled:true,lastAiAt:new Date().toISOString(),lastDecision:null});try{result=await aiDecision({symbol,timeframe:"M5",trigger:"H1_CLOSE_12_M5",weights:{technical:70,fundamental:30},technical,technicalScore:techScore,technicalDirection:side,fundamental:{...fundamental,score:fundamentalScore},weightedScore,candles});result=enforceWeb1Blueprint(result);aiRuntime.set(symbol,{state:"AI_COMPLETED",aiCalled:true,lastAiAt:new Date().toISOString(),lastDecision:result.decision||null});}catch(e){aiRuntime.set(symbol,{state:"AI_ERROR",aiCalled:true,lastAiAt:new Date().toISOString(),lastDecision:null,error:e.message});throw e;}}if(!aiRuntime.get(symbol)?.aiCalled)aiRuntime.set(symbol,{state:"SMC_REJECTED",aiCalled:false,lastAiAt:aiRuntime.get(symbol)?.lastAiAt||null,lastDecision:result.decision||"NO_TRADE"});return{technicalScore:techScore,fundamentalScore,fundamentalStatus:fundamentalMissing?"MISSING":"LIVE_INPUT",weightedScore,technical,aiCalled:!!aiRuntime.get(symbol)?.aiCalled,result,analyzedAt:new Date().toISOString()};}
app.post("/api/m5/candle",bridgeAuth,async(req,res)=>{
 lastMt5At=Date.now();
 try{
  await touchHeartbeat("MT5").catch(e=>console.error("heartbeat db write",e.message));
  const {symbol="XAUUSD",candle}=req.body;
  if(!candle?.time)return res.status(400).json({error:"candle.time required"});
  const key=symbol.toUpperCase(),t=new Date(candle.time);
  if(!Number.isFinite(t.getTime()))return res.status(400).json({error:"Invalid candle.time"});
  if(t.getUTCMinutes()%5!==0)return res.status(400).json({error:"Invalid M5 slot"});
  const hour=t.toISOString().slice(0,13),blockStart=new Date(t);blockStart.setUTCMinutes(0,0,0);
  const ingestId=key+":"+t.toISOString();
  if(lastM5Ingest.get(key)===ingestId)return res.json({status:"DUPLICATE_IGNORED",candleTime:t.toISOString(),ingestOnly:true});
  lastM5Ingest.set(key,ingestId);
  try{
   await saveM5Candle(key,candle);
   const tradeEvents=await updateOpenTrades(key,candle);
   const shadowEvents=await updateCancelledShadowLearning(key,candle).catch(e=>{console.error("CANCELLED_SHADOW_TRACK_ERROR",e.message);return[]});
   for(const ev of shadowEvents)console.log("CANCELLED_SHADOW_UPDATED",key,JSON.stringify(ev));
   await handlePendingSetupEvents(key,tradeEvents.filter(x=>x?.status==="CANCELLED"));
   for(const ev of tradeEvents.filter(x=>x?.status==="ENTRY_TOUCHED")){try{await sendTelegramLifecycle(key,ev)}catch(te){console.error("Telegram entry update failed",te.message)}}
   await learnFromClosedTrades(key,tradeEvents);
  }catch(e){console.error("M5 trade tracking/db write",e.message)}
  let arr=[];
  try{arr=await getM5Block(key,blockStart)}catch(e){console.error("M5 db read",e.message)}
  arr.sort((a,b)=>new Date(a.time)-new Date(b.time));
  buffers.set(key,arr.slice(-12));
  const closedM5=arr.length;
  const prev=aiRuntime.get(key)||{};
  aiRuntime.set(key,{...prev,state:closedM5>=12?"WAITING_H1_MTF_ANALYSIS":"COLLECTING_M5",closedM5});
  return res.json({status:closedM5>=12?"H1_BLOCK_READY":"COLLECTING",closedM5,required:12,hour,ingestOnly:true,analysisEndpoint:"/api/mtf/analyze"});
 }catch(e){res.status(400).json({error:e.message})}
});
app.post("/api/mtf/analyze",bridgeAuth,async(req,res)=>{try{
 const {symbol="XAUUSD",previousD1,h1=[],m15=[],m5=[],m3=[],m1=[],fundamental={}}=req.body;
 const key=symbol.toUpperCase();
 if(!previousD1?.time)return res.status(400).json({error:"previousD1 closed candle required"});
 if(!Array.isArray(h1)||!Array.isArray(m15)||!Array.isArray(m5)||!Array.isArray(m3)||!Array.isArray(m1)||h1.length<2||m15.length<4||m5.length<12)return res.status(400).json({error:"MTF history insufficient",required:{h1:2,m15:4,m5:12},optionalExecutionRefinement:{m3:20,m1:30}});
 const normalizeCandle=x=>{if(!x||typeof x!=="object")return null;const time=x.time??x.timestamp??x.datetime;return {...x,time,open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),closed:x.closed!==false}};
 const d1=normalizeCandle(previousD1),H1=h1.map(normalizeCandle),M15=m15.map(normalizeCandle),M5=m5.map(normalizeCandle),M3=m3.map(normalizeCandle),M1=m1.map(normalizeCandle);
 console.log("MTF_PAYLOAD_LENGTHS",JSON.stringify({symbol:key,h1:H1.length,m15:M15.length,m5:M5.length,m3:M3.length,m1:M1.length}));
 const valid=x=>x&&x.closed&&x.time!=null&&!Number.isNaN(new Date(x.time).getTime())&&[x.open,x.high,x.low,x.close].every(Number.isFinite);
 const bad={d1:valid(d1)?0:1,h1:H1.filter(x=>!valid(x)).length,m15:M15.filter(x=>!valid(x)).length,m5:M5.filter(x=>!valid(x)).length,m3:M3.filter(x=>!valid(x)).length,m1:M1.filter(x=>!valid(x)).length};
 if(bad.d1||bad.h1||bad.m15||bad.m5||bad.m3||bad.m1){console.error("MTF_INVALID_PAYLOAD",JSON.stringify({symbol:key,bad,lengths:{h1:H1.length,m15:M15.length,m5:M5.length,m3:M3.length,m1:M1.length}}));return res.status(400).json({error:"Invalid MTF candle payload",bad,lengths:{h1:H1.length,m15:M15.length,m5:M5.length,m3:M3.length,m1:M1.length}})}
 try{
  const saved=await Promise.all([saveMtfCandles(key,"H1",H1),saveMtfCandles(key,"M15",M15),saveMtfCandles(key,"M5",M5)]);
  console.log("MTF_HISTORY_SAVED",JSON.stringify({symbol:key,h1:saved[0],m15:saved[1],m5:saved[2]}));
 }catch(e){console.error("MTF_HISTORY_SAVE_ERROR",key,e.message)}
 const h1Last=H1.at(-1),h1Prev=H1.at(-2);
 const h1CloseTime=new Date(h1Last.time);
 if(Number.isNaN(h1CloseTime.getTime()))return res.status(400).json({error:"Invalid last H1 time"});
 // Normalize the signal key/time to the CLOSED H1 candle slot, never to M5/request arrival time.
 const h1Slot=new Date(h1CloseTime);h1Slot.setUTCMinutes(0,0,0);
 const hourlyId=key+":"+h1Slot.toISOString();
 if(lastSignal.get(key+":HOURLY")===hourlyId || await hasHourlyAnalysis(hourlyId) || await hasTradeSignal(hourlyId))return res.json({status:"ALREADY_ANALYZED",hourlyId,latest:latest.get(key)||null});
 const dailyBias=d1.close>d1.open?"BUY":d1.close<d1.open?"SELL":"NEUTRAL";
 const h1Direction=+h1Last.close>+h1Prev.high?"BUY":+h1Last.close<+h1Prev.low?"SELL":(+h1Last.close>=+h1Last.open?"BULLISH":"BEARISH");
 const technical=analyzeRollingM5(M5,{direction:h1Direction});
 const side=technical.bullishScore>=technical.bearishScore?"BUY":"SELL",techScore=Math.max(technical.bullishScore,technical.bearishScore);
 let fund=fundamental;if(!Number.isFinite(Number(fund.score)))fund=await getFundamental();
 const fundamentalScore=Number.isFinite(Number(fund.score))?Number(fund.score):null;
 const weightedScore=fundamentalScore==null?+(techScore*.7).toFixed(2):+(techScore*.7+fundamentalScore*.3).toFixed(2);
 const px=Number(livePrice.get(key)?.price);if(Number.isFinite(px)){const pendingEvents=await evaluatePendingSetups(key,px).catch(()=>[]);await handlePendingSetupEvents(key,pendingEvents);}
 // Bootstrap from recent finalized outcomes: today first, then up to 7 days.
 // The DB attaches time-decay weights; after a preliminary profile we re-rank
 // same-regime examples so current market conditions matter more than stale history.
 let learningMemory=await getRollingLearningMemory(key,{minSamples:20,maxDays:7,limit:200}).catch(()=>[]);
 const recentRegime=learningMemory.find(x=>x?.regime&&x.regime!=="UNKNOWN")?.regime||null;
 if(recentRegime)learningMemory=await getRollingLearningMemory(key,{minSamples:20,maxDays:7,limit:200,currentRegime:recentRegime}).catch(()=>learningMemory);
 const longTermMemory=await getLongTermLearningMemory(key,{maxDays:90,limit:1000,currentRegime:recentRegime}).catch(()=>[]);
const cancelledMemory=await getCancelledLearningMemory(key,{maxDays:90,limit:1000,currentRegime:recentRegime}).catch(()=>[]);
const cancelledShadow=await getCancelledShadowLearning(key,{maxDays:90,limit:1000}).catch(()=>[]);
const baselineMemory=await getLearningBaseline(key).catch(()=>[]);
const baselineShadow=await getCancelledShadowBaseline(key).catch(()=>[]);
const baselineProfile=buildAdaptiveProfile(baselineMemory);
const adaptiveProfile=buildAdaptiveProfile(learningMemory);
adaptiveProfile.continuousLearningSinceSep30={
 period:"2026-09-30..present",
 finalSamples:baselineProfile.finalSamples,
 performance:baselineProfile.performance,
 strategyAdjustments:baselineProfile.strategyAdjustments,
 bestEntryPatterns:baselineProfile.bestEntryPatterns,
 learningActions:baselineProfile.learningActions,
 cancelledShadow:{samples:baselineShadow.length,tp1:baselineShadow.filter(x=>x.shadow_outcome==='TP1').length,tp2:baselineShadow.filter(x=>x.shadow_outcome==='TP2').length,sl:baselineShadow.filter(x=>x.shadow_outcome==='SL').length,notRetouched:baselineShadow.filter(x=>x.shadow_outcome==='ENTRY_NOT_RETOUCHED').length},
 rule:"Continuous lifetime learning from Sep 30 onward. Every new finalized TP1/TP2/SL and CANCELLED shadow observation is incorporated automatically. Promote/deprioritize only repeated patterns with adequate samples; recent/current-regime evidence remains dominant so old market conditions cannot freeze the model. Never override risk guardrails."
};
adaptiveProfile.cancelledSetupLearning=buildCancelledLearningProfile(cancelledMemory);
adaptiveProfile.cancelledSetupLearning.counterfactual={samples:cancelledShadow.length,entryRetouched:cancelledShadow.filter(x=>x.entry_touched_after_cancel).length,tp1:cancelledShadow.filter(x=>x.shadow_outcome==='TP1').length,tp2:cancelledShadow.filter(x=>x.shadow_outcome==='TP2').length,sl:cancelledShadow.filter(x=>x.shadow_outcome==='SL').length,notRetouched:cancelledShadow.filter(x=>x.shadow_outcome==='ENTRY_NOT_RETOUCHED').length,recent:cancelledShadow.slice(0,20).map(x=>({hourlyId:x.hourly_id,reason:x.cancel_reason,side:x.side,strategy:x.strategy,regime:x.regime,outcome:x.shadow_outcome,entryRetouched:x.entry_touched_after_cancel}))};
const shadowFinal=cancelledShadow.filter(x=>['TP1','TP2','SL'].includes(x.shadow_outcome));
const shadowWins=shadowFinal.filter(x=>['TP1','TP2'].includes(x.shadow_outcome)).length,shadowLosses=shadowFinal.filter(x=>x.shadow_outcome==='SL').length;
adaptiveProfile.cancelledSetupLearning.feedback={
 shadowFinalSamples:shadowFinal.length,
 shadowWinRatePct:shadowFinal.length?+(shadowWins*100/shadowFinal.length).toFixed(1):null,
 cancellationBias:shadowFinal.length<5?'OBSERVE':shadowWins/shadowFinal.length>=0.65?'TOO_AGGRESSIVE_REVIEW_REACHABILITY':shadowLosses/shadowFinal.length>=0.60?'PROTECTIVE_KEEP_SAFETY':'BALANCED',
 rule:"Apply only when repeated evidence exists. Shadow winners may relax reachability/timing ranking only when live structure remains valid; shadow losses reinforce cancellation safety. Never change SL/RR/risk or resurrect cancelled trades."
};
// Historical learning includes Sep 30 onward through the 90-day memory; recent 7-day evidence remains dominant.
const longTermProfile=buildAdaptiveProfile(longTermMemory);
adaptiveProfile.longTermLearning={
 windowDays:90,
 finalSamples:longTermProfile.finalSamples,
 strategyAdjustments:longTermProfile.strategyAdjustments,
 bestEntryPatterns:longTermProfile.bestEntryPatterns,
 bestEntryConclusion:longTermProfile.bestEntryConclusion,
 performance:longTermProfile.performance,
 learningActions:longTermProfile.learningActions,
 rule:"Long-term memory preserves lessons from older finalized trades while recent 7-day learning remains dominant for current-market adaptation. Winning patterns are reinforced and losing patterns corrected, but old data may support confidence only and must never override live structure or current regime."
};
const recentFinalized=learningMemory.slice().sort((a,b)=>new Date(b.reviewed_at||b.created_at||0)-new Date(a.reviewed_at||a.created_at||0));
const consecutiveSL=recentFinalized.findIndex(x=>x?.outcome!=="SL");
const slStreak=consecutiveSL===-1?recentFinalized.length:consecutiveSL;
if(slStreak>=2){
 const losses=recentFinalized.slice(0,slStreak);
 const recentWins=recentFinalized.filter(x=>["TP1","TP2"].includes(x?.outcome)).slice(0,5);
 const strategies=[...new Set(losses.map(x=>String(x.strategy||x.review?.strategyUsed||"UNKNOWN")))];
 const regimes=[...new Set(losses.map(x=>String(x.regime||x.review?.marketRegime||"UNKNOWN")))];
 adaptiveProfile.lossStreakReview={triggered:true,consecutiveSL:slStreak,strategies,regimes,causes:losses.map(x=>x.review?.primaryCause).filter(Boolean),lossCases:losses.map(x=>({hourlyId:x.hourly_id||x.hourlyId,regime:x.regime,strategy:x.strategy,outcome:x.outcome,review:x.review,context:x.context})),recentWinningCases:recentWins.map(x=>({hourlyId:x.hourly_id||x.hourlyId,regime:x.regime,strategy:x.strategy,outcome:x.outcome,review:x.review,context:x.context})),instruction:"MANDATORY DEEP REVIEW BEFORE NEXT ENTRY: two or more consecutive finalized SL detected. Compare the loss cases against recent winning cases. Identify the common pre-loss pattern in regime, D1/H1/M15 alignment, lower-TF trigger, POI freshness/reachability, displacement/sweep/BOS-MSS evidence, entry timing and whether price was already extended. Convert that comparison into explicit avoid/require conditions for this next decision. Do not simply reverse direction after losses and do not repeat the same weak pattern. Deprioritize the failing method/regime combination unless current evidence is materially stronger; actively compare POI versus ENGULFING_DIRECT/BREAKOUT_DIRECT/BREAKOUT_RETEST/BREAKOUT_CONTINUATION and choose NO_TRADE when no structurally superior setup exists. Learning changes selection quality only and MUST NOT change blueprint risk, SL 35-60 pips, TP1=1R, TP2=2R, or one-analysis-per-H1."};
}
console.log("AI_ADAPTIVE_PROFILE",JSON.stringify({symbol:key,hourlyId,...adaptiveProfile}));
 let result=await aiDecision({symbol:key,mode:"HOURLY_D1_MTF_ANALYSIS",trigger:"CLOSED_H1",daily:{previousClosedD1:d1,bias:dailyBias},timeframes:{h1:H1.slice(-24),m15:M15.slice(-32),m5:M5.slice(-36),m3:M3.slice(-60),m1:M1.slice(-90)},structure:{h1Direction},technical,technicalScore:techScore,technicalDirection:side,fundamental:{...fund,score:fundamentalScore},weightedScore,thresholds:{minTechnical:minTech,minFinal},weights:{technical:70,fundamental:30},learningMemory,adaptiveProfile,rule:"Analyze exactly once per newly closed H1. For Web 1, select ONE best available structurally valid BUY/SELL setup per H1 using learningMemory plus live H1/M15 and M5/M3/M1 evidence. If adaptiveProfile.lossStreakReview.triggered is true, complete that mandatory review before selecting the next entry and do not repeat the same weak method/regime pattern without materially stronger structural evidence. Use adaptiveProfile.learningActions explicitly: reinforce recurring WIN conditions when current structure confirms them, and apply LOSS corrections/avoid rules before repeating a previously failing setup. Also use adaptiveProfile.cancelledSetupLearning as setup-quality evidence. Its counterfactual shadow data shows what happened AFTER cancellation: whether entry was later retouched and whether the hypothetical path reached TP1, TP2 or SL. Use repeated shadow TP1/TP2 after similar cancellations as evidence that cancellation/entry reachability may be too aggressive; use repeated shadow SL as evidence that cancellation protected capital. CANCELLED setups remain excluded from official WIN/LOSS, WR, PF and PnL. Never resurrect or execute a cancelled historical setup. Also use adaptiveProfile.continuousLearningSinceSep30 as cumulative lifetime evidence from Sep 30 through the present, plus adaptiveProfile.bestEntryPatterns/bestEntryConclusion as recent tactical memory and adaptiveProfile.longTermLearning as decayed historical memory. Incorporate every newly finalized trade and CANCELLED shadow observation. Directly PREFER repeated positive-expectancy/high-WR patterns and DEPRIORITIZE or AVOID repeated negative-expectancy/low-WR patterns only when sample evidence is adequate. Current live structure and matching recent regime remain the final gate so the system adapts as market behavior changes. Prefer patterns that are strong in both layers; when recent and long-term disagree, prioritize recent regime/structure and treat long-term evidence as secondary. Evaluate improvement jointly by WR, PF, realized PnL/Net-R, expectancy and drawdown; never improve one metric by materially degrading the others. Never force a historical favorite into an invalid live market. Rank POI, ENGULFING_DIRECT, BREAKOUT_DIRECT, BREAKOUT_RETEST and BREAKOUT_CONTINUATION candidates; do not reject solely on a fixed confidence threshold. NO_TRADE is only a final safety exception when no candidate has valid structure and a 35-60 pip structural stop. Return BUY or SELL only when the setup is high quality; otherwise return NO_TRADE. A trade requires coherent H1/M15 direction plus a valid M5/M3/M1 execution trigger: (1) fresh reachable POI from Supply/Demand, strong SNR, OB or FVG with displacement/rejection/sweep evidence, OR (2) strong ENGULFING_DIRECT at meaningful structure, OR (3) confirmed breakout close/retest/continuation with displacement. Prefer at least two confluences. When H1/M15 conflict or the primary POI is stale, continue ranking the remaining M5/M3/M1 candidates and select the safest structurally valid alternative. Reject wick-only/chasing candidates, but for HOURLY mode do not stop searching until POI, ENGULFING_DIRECT, BREAKOUT_DIRECT, BREAKOUT_RETEST and BREAKOUT_CONTINUATION have all been evaluated. NO_TRADE is permitted only when every candidate fails structural safety or no 35-60 pip structural invalidation exists. For XAUUSD Web 1, derive SL from the nearest valid structural invalidation/POI/swing and require Entry-to-SL distance of 35-60 pips (3.50-6.00 price units). BUY SL must be below entry; SELL SL must be above entry. Never use less than 35 or more than 60 pips. Derive TP1=1R and TP2=2R from the actual final Entry-to-SL distance."});
 result=enforceWeb1Blueprint(result);
 // Final publication gate: never publish a setup already invalid at the newest market snapshot.
 if(["BUY","SELL"].includes(result.decision)){
  const side=result.decision,entry=Number(result.entry),sl=Number(result.stopLoss),tp1=Number(result.takeProfit1);
  const last=[M1.at(-1),M3.at(-1),M5.at(-1)].filter(Boolean).sort((a,b)=>new Date(b.time)-new Date(a.time))[0];
  const live=Number(last?.close);
  const valid=Number.isFinite(live)&&Number.isFinite(entry)&&Number.isFinite(sl)&&Number.isFinite(tp1);
  const slPassed=valid&&(side==="BUY"?live<=sl:live>=sl);
  const targetPassed=valid&&(side==="BUY"?live>=tp1:live<=tp1);
  if(!valid||slPassed||targetPassed){
   const why=!valid?"MISSING_FRESH_MARKET_SNAPSHOT":slPassed?"STOP_ALREADY_PASSED_BEFORE_PUBLICATION":"TARGET_ALREADY_PASSED_BEFORE_PUBLICATION";
   console.log("PREPUBLICATION_NO_TRADE",JSON.stringify({symbol:key,hourlyId,why,live,entry,sl,tp1}));
   result={...result,decision:"NO_TRADE",entry:null,stopLoss:null,takeProfit1:null,takeProfit2:null,entryReason:"Pre-publication gate: "+why,technicalReason:"Pre-publication gate: "+why,invalidation:why,prePublicationRejected:true};
  }
 }
 console.log("MTF_DECISION",JSON.stringify({symbol:key,hourlyId,decision:result?.decision,confidence:result?.confidence,entry:result?.entry,stopLoss:result?.stopLoss,tp1:result?.takeProfit1,tp2:result?.takeProfit2,strategy:result?.strategyUsed,reason:result?.entryReason||result?.technicalReason||null,payload:{m1:M1.slice(-90).length,m3:M3.slice(-60).length,m5:M5.slice(-36).length,m15:M15.slice(-32).length,h1:H1.slice(-24).length}}));
 if(["BUY","SELL"].includes(result.decision)&&[result.entry,result.stopLoss,result.takeProfit1,result.takeProfit2].every(v=>Number.isFinite(Number(v)))){await saveTradeSignal({hourlyId,symbol:key,side:result.decision,entry:+result.entry,stopLoss:+result.stopLoss,tp1:+result.takeProfit1,tp2:+result.takeProfit2,confidence:+result.confidence||null,signalTime:h1Slot.toISOString()});
 await saveTradeLearningContext({hourlyId,symbol:key,regime:result.marketRegime||"UNKNOWN",strategy:result.strategyUsed||result.executionType||"UNKNOWN",context:{dailyBias,h1Direction,technicalScore:techScore,fundamentalScore,weightedScore,confidence:result.confidence,entryReason:result.entryReason,technicalReason:result.technicalReason,m15Reason:result.m15Reason,m5Reason:result.m5Reason,marketSnapshot:{h1:H1.slice(-12).map(x=>[x.time,x.open,x.high,x.low,x.close]),m15:M15.slice(-16).map(x=>[x.time,x.open,x.high,x.low,x.close]),m5:M5.slice(-24).map(x=>[x.time,x.open,x.high,x.low,x.close])}}})}
 await saveHourlyAnalysis({hourlyId,symbol:key,decision:result.decision});
 const record={mode:"HOURLY_D1_MTF_ANALYSIS",hourlyId,dailyBias,h1Direction,technicalScore:techScore,fundamentalScore,weightedScore,result,analyzedAt:new Date().toISOString()};
 calculateTargetProbabilities(record,result);
 latest.set(key,record);lastSignal.set(key+":HOURLY",hourlyId);aiRuntime.set(key,{state:result.decision==="NO_TRADE"?"HOURLY_WAIT":"AI_COMPLETED",aiCalled:true,lastAiAt:new Date().toISOString(),lastDecision:result.decision});
 let telegram={sent:false};try{telegram=await sendTelegramSignal(key,record)}catch(e){telegram={sent:false,error:e.message};console.error("Hourly Telegram failed",e.message)}
 res.json({status:result.decision==="NO_TRADE"?"WAIT":"SIGNAL",telegram,...record});
}catch(e){console.error("MTF_ANALYZE_ERROR",e?.stack||e?.message||e);res.status(400).json({error:e.message})}});
app.post("/api/analyze",bridgeAuth,async(req,res)=>{try{const{symbol="XAUUSD",candles,fundamental={},h1Context={}}=req.body;const record=await run(symbol.toUpperCase(),candles,fundamental,h1Context);latest.set(symbol.toUpperCase(),record);res.json(record)}catch(e){res.status(400).json({error:e.message})}});
const port=process.env.PORT||3000;
initDb().then(async()=>{
 await normalizeLegacyHourlySignals("XAUUSD");
 console.log("Database heartbeat ready");
 try{
  const recent=await getRollingLearningMemory("XAUUSD",{minSamples:20,maxDays:7,limit:500,currentRegime:null});
  const longTerm=await getLongTermLearningMemory("XAUUSD",{maxDays:90,limit:1000,currentRegime:null});
  const cancelled=await getCancelledLearningMemory("XAUUSD",{maxDays:90,limit:1000,currentRegime:null});
  const allSinceSep30=await getTradesBetween("XAUUSD","2026-09-30T00:00:00Z",new Date().toISOString());
  const recentProfile=buildAdaptiveProfile(recent);
  const longProfile=buildAdaptiveProfile(longTerm);
  const statusCounts=allSinceSep30.reduce((o,x)=>{const k=String(x.status||x.lifecycle_status||"UNKNOWN");o[k]=(o[k]||0)+1;return o;},{});
  const compact=p=>p?{
   samples:p.finalSamples,
   performance:p.performance,
   bestEntryConclusion:p.bestEntryConclusion,
   strategyAdjustments:p.strategyAdjustments,
   winRules:p.learningActions?.reinforcedWinRules?.length||0,
   lossRules:p.learningActions?.lossCorrections?.length||0
  }:null;
  console.log("LEARNING_BOOTSTRAP_READY",JSON.stringify({
   symbol:"XAUUSD",
   totalRecordsSinceSep30:allSinceSep30.length,
   statusCountsSinceSep30:statusCounts,
   cancelledSetups:cancelled.length,
   cancelledReviewed:cancelled.filter(x=>x.review).length,
   cancelledLearning:buildCancelledLearningProfile(cancelled),
   reviewedRecent:recent.filter(x=>x.review&&["TP1","TP2","SL"].includes(x.outcome)).length,
   reviewedLongTerm:longTerm.filter(x=>x.review&&["TP1","TP2","SL"].includes(x.outcome)).length,
   recent:compact(recentProfile),
   longTerm:compact(longProfile),
   rule:"Startup audit only. Learning uses finalized TP1/TP2/SL, reinforces WIN evidence, corrects LOSS evidence, and never changes blueprint guardrails."
  }));
 }catch(e){console.error("LEARNING_BOOTSTRAP_ERROR",e.message)}
}).catch(e=>console.error("Database init failed",e.message));
let lastMarketCloseSweepKey=null;
async function sweepMarketClosePending(){
 const now=new Date();
 if(now.getUTCHours()!==21)return;
 const key=now.toISOString().slice(0,13);
 if(lastMarketCloseSweepKey===key)return;
 lastMarketCloseSweepKey=key;
 try{
  const cancelled=await cancelPendingAtMarketClose("XAUUSD",now);
  if(cancelled.length){
   console.log("MARKET_CLOSE_PENDING_CANCELLED",JSON.stringify({count:cancelled.length,hourUtc:key}));
   await handlePendingSetupEvents("XAUUSD",cancelled);
  }else{
   console.log("MARKET_CLOSE_PENDING_SWEEP_OK",JSON.stringify({count:0,hourUtc:key}));
  }
 }catch(e){
  lastMarketCloseSweepKey=null;
  console.error("MARKET_CLOSE_PENDING_SWEEP_ERROR",e.message);
 }
}
setInterval(sweepMarketClosePending,30000);
setTimeout(sweepMarketClosePending,3000);
app.listen(port,()=>console.log("SMC AI listening on",port));