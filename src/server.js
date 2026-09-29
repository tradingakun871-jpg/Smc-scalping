import express from "express";
import {analyzeSMC} from "./smc.js";
import {aiDecision} from "./ai.js";
const app=express();app.use(express.json({limit:"1mb"}));app.use(express.static("public"));
const buffers=new Map(),lastSignal=new Map(),latest=new Map();
const minTech=Number(process.env.MIN_TECHNICAL_SCORE||70),minFinal=Number(process.env.MIN_FINAL_SCORE||70);
const noTrade=reason=>({decision:"NO_TRADE",confidence:0,entry:null,stopLoss:null,takeProfit1:null,takeProfit2:null,technicalReason:reason,fundamentalReason:"Not evaluated because mandatory SMC gate failed",invalidation:""});
app.get("/health",(req,res)=>res.json({ok:true,service:"smc-scalping-ai",engine:"12_M5_H1_SMC",minTech,minFinal}));
app.get("/api/status",(req,res)=>{const key=String(req.query.symbol||"XAUUSD").toUpperCase();res.json({symbol:key,closedM5:(buffers.get(key)||[]).length,required:12,latest:latest.get(key)||null});});
async function run(symbol,candles,fundamental={},h1Context={}){
 const technical=analyzeSMC(candles,h1Context),side=technical.bullishScore>=technical.bearishScore?"BUY":"SELL",techScore=Math.max(technical.bullishScore,technical.bearishScore);
 const fundamentalMissing=!Number.isFinite(Number(fundamental.score)),fundamentalScore=fundamentalMissing?null:Number(fundamental.score);
 const mandatory=side==="BUY"?technical.mandatoryBuy:technical.mandatorySell;
 let weightedScore=fundamentalScore==null?+(techScore*.7).toFixed(2):+(techScore*.7+fundamentalScore*.3).toFixed(2),result;
 if(!mandatory||techScore<minTech)result=noTrade(!mandatory?"Mandatory SMC setup incomplete":"Technical score below threshold");
 else if(fundamentalScore==null)result=noTrade("Fundamental snapshot missing");
 else if(weightedScore<minFinal)result=noTrade("Final weighted score below threshold");
 else result=await aiDecision({symbol,timeframe:"M5",trigger:"H1_CLOSE_12_M5",weights:{technical:70,fundamental:30},technical,technicalScore:techScore,technicalDirection:side,fundamental:{...fundamental,score:fundamentalScore},weightedScore,candles});
 return{technicalScore:techScore,fundamentalScore,fundamentalStatus:fundamentalMissing?"MISSING":"LIVE_INPUT",weightedScore,technical,result,analyzedAt:new Date().toISOString()};
}
app.post("/api/m5/candle",async(req,res)=>{try{const{symbol="XAUUSD",candle,fundamental={},h1Context={}}=req.body;if(!candle?.time)return res.status(400).json({error:"candle.time required"});const key=symbol.toUpperCase(),hour=new Date(candle.time).toISOString().slice(0,13),old=buffers.get(key)||[],arr=old.filter(x=>new Date(x.time).toISOString().slice(0,13)===hour);if(!arr.some(x=>x.time===candle.time))arr.push(candle);arr.sort((a,b)=>new Date(a.time)-new Date(b.time));buffers.set(key,arr);if(arr.length<12)return res.json({status:"COLLECTING",closedM5:arr.length,required:12,hour});const blockId=hour;if(lastSignal.get(key)===blockId)return res.json({status:"ALREADY_ANALYZED",blockId});const record={blockId,...await run(key,arr,fundamental,h1Context)};latest.set(key,record);lastSignal.set(key,blockId);buffers.set(key,[]);res.json({status:"ANALYZED",...record});}catch(e){res.status(400).json({error:e.message});}});
app.post("/api/analyze",async(req,res)=>{try{const{symbol="XAUUSD",candles,fundamental={},h1Context={}}=req.body;const record=await run(symbol.toUpperCase(),candles,fundamental,h1Context);latest.set(symbol.toUpperCase(),record);res.json(record)}catch(e){res.status(400).json({error:e.message})}});
const port=process.env.PORT||3000;app.listen(port,()=>console.log("SMC AI listening on",port));