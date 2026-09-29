import express from "express";
import {analyzeSMC} from "./smc.js";
import {aiDecision} from "./ai.js";
const app=express(); app.use(express.json({limit:"1mb"}));
const buffers=new Map(), lastSignal=new Map();
app.get("/health",(req,res)=>res.json({ok:true,service:"smc-scalping-ai",model:process.env.OPENAI_MODEL||"gpt-5.6-luna"}));
app.post("/api/m5/candle",async(req,res)=>{
 try{
  const {symbol="XAUUSD",candle,fundamental={}}=req.body;
  if(!candle?.time) return res.status(400).json({error:"candle.time required"});
  const key=symbol.toUpperCase(), arr=buffers.get(key)||[];
  if(!arr.some(x=>x.time===candle.time)) arr.push(candle);
  arr.sort((a,b)=>new Date(a.time)-new Date(b.time)); buffers.set(key,arr.slice(-12));
  if(buffers.get(key).length<12) return res.json({status:"COLLECTING",closedM5:buffers.get(key).length,required:12});
  const block=buffers.get(key), end=new Date(block[11].time), blockId=end.toISOString().slice(0,13);
  if(lastSignal.get(key)===blockId) return res.json({status:"ALREADY_ANALYZED",blockId});
  const technical=analyzeSMC(block);
  const fundamentalScore=Number(fundamental.score??50);
  const techDirection=technical.bullishScore>=technical.bearishScore?"BUY":"SELL";
  const techScore=Math.max(technical.bullishScore,technical.bearishScore);
  const weightedScore=+(techScore*.70+fundamentalScore*.30).toFixed(2);
  const result=await aiDecision({symbol:key,timeframe:"M5",trigger:"12_CLOSED_M5",weights:{technical:70,fundamental:30},technical,technicalScore:techScore,technicalDirection:techDirection,fundamental:{...fundamental,score:fundamentalScore},weightedScore,candles:block});
  lastSignal.set(key,blockId); buffers.set(key,[]);
  res.json({status:"ANALYZED",blockId,weightedScore,result});
 }catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/analyze",async(req,res)=>{
 try{
  const {symbol="XAUUSD",candles,fundamental={}}=req.body;
  const technical=analyzeSMC(candles), fundamentalScore=Number(fundamental.score??50);
  const techDirection=technical.bullishScore>=technical.bearishScore?"BUY":"SELL", techScore=Math.max(technical.bullishScore,technical.bearishScore);
  const weightedScore=+(techScore*.7+fundamentalScore*.3).toFixed(2);
  const result=await aiDecision({symbol,timeframe:"M5",weights:{technical:70,fundamental:30},technical,technicalScore:techScore,technicalDirection:techDirection,fundamental:{...fundamental,score:fundamentalScore},weightedScore,candles});
  res.json({weightedScore,result});
 }catch(e){res.status(400).json({error:e.message});}
});
const port=process.env.PORT||3000; app.listen(port,()=>console.log("SMC AI listening on",port));