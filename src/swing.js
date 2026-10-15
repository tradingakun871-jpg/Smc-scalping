import pg from "pg";
import OpenAI from "openai";
import {notifySwing} from "./swing-telegram.js";
import {trackSwing,registerSwing,swingMetrics} from "./swing-outcomes.js";
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL,max:2}):null;
let ready;
const inFlight=new Set();
const init=()=>ready??=(async()=>{if(!pool)throw Error("DB_UNAVAILABLE");await pool.query(`CREATE TABLE IF NOT EXISTS swing_analysis (id TEXT PRIMARY KEY,symbol TEXT NOT NULL,trigger_time TIMESTAMPTZ NOT NULL,decision TEXT NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);await pool.query(`CREATE TABLE IF NOT EXISTS swing_candles (symbol TEXT NOT NULL,timeframe TEXT NOT NULL,candle_time TIMESTAMPTZ NOT NULL,payload JSONB NOT NULL,PRIMARY KEY(symbol,timeframe,candle_time))`);})();
const clean=(items,limit)=>{if(!Array.isArray(items))return [];return items.slice(-limit).map(x=>({...x,open:+x.open,high:+x.high,low:+x.low,close:+x.close})).filter(x=>x.closed!==false&&x.time&&Number.isFinite(new Date(x.time).getTime())&&[x.open,x.high,x.low,x.close].every(Number.isFinite));};
const iso=x=>new Date(x.time).toISOString();
export async function ingestSwing({symbol="XAUUSD",w1=[],h4=[],h1=[],m15=[]}){
 const data={w1:clean(w1,52),h4:clean(h4,120),h1:clean(h1,24),m15:clean(m15,64)};
 if(data.w1.length<12||data.h4.length<24||data.h1.length<12||data.m15.length<24){console.warn("SWING_DATA_INCOMPLETE",JSON.stringify(Object.fromEntries(Object.entries(data).map(([k,v])=>[k,v.length]))));return;}
 await init();
 await trackSwing(symbol,data.m15);
 for(const [tf,arr] of [["W1",data.w1],["H4",data.h4]]){
  for(const c of arr)await pool.query("INSERT INTO swing_candles(symbol,timeframe,candle_time,payload) VALUES($1,$2,$3,$4) ON CONFLICT(symbol,timeframe,candle_time) DO UPDATE SET payload=EXCLUDED.payload",[symbol,tf,iso(c),JSON.stringify(c)]);
 }
 // Trigger only on a newly CLOSED H4 bar; idempotency is DB-backed.
 const last=data.h4.at(-1);
 const anchor=new Date(data.h1.at(-1).time);
 const hour=Number(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Jakarta",hour:"2-digit",hourCycle:"h23"}).format(anchor));
 const session=hour>=20||hour<5?"NEW_YORK":hour>=14?"LONDON":"ASIA";
 const sessionDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta",year:"numeric",month:"2-digit",day:"2-digit"}).format(anchor);
 const id=symbol+":SWING:"+sessionDate+":"+session;
 const ageMs=Date.now()-new Date(last.time).getTime();
 if(ageMs>12*3600000||ageMs<0){console.warn("SWING_STALE_H4",JSON.stringify({symbol,ageHours:Math.round(ageMs/3600000)}));return;}
 const existing=await pool.query("SELECT id,payload,decision FROM swing_analysis WHERE id=$1",[id]);if(existing.rowCount){if(["BUY","SELL"].includes(existing.rows[0].decision))await notifySwing(id,symbol,iso(last),existing.rows[0].payload).catch(e=>console.error("SWING_NOTIFY_RETRY_ERROR",e.message));return;}
 // Do not run a second live AI call on each H1 retry; lock the H4 trigger.
 if(inFlight.has(id))return;
 inFlight.add(id);
 try{
  if((await pool.query("SELECT 1 FROM swing_analysis WHERE id=$1",[id])).rowCount)return;
  const historical=await pool.query("SELECT a.payload->>'decision' AS decision,a.payload->>'setup' AS setup,a.payload->>'reason' AS reason,o.status,o.pnl_r FROM swing_analysis a LEFT JOIN swing_outcomes o ON o.signal_id=a.id WHERE a.symbol=$1 ORDER BY a.trigger_time DESC LIMIT 80",[symbol]);
  const outcomes=await swingMetrics(symbol);
  const input={symbol,outcomes,mode:"SWING_SIGNAL_ONLY",session,sessionDate,sessionTarget:"Publish at least one independently validated BUY/SELL candidate each session when market data demonstrates a valid setup; never fabricate entry levels. If no candidate meets requirements, explicitly give NO_TRADE with failure reason.",triggerH4:iso(last),timeframes:data,priorSwingDecisions:historical.rows,learningRule:"Evaluate finalized TP1/SL, compare setup/regime and avoid repeated losses. CANCELLED is reachability feedback only, never a win or loss. AMBIGUOUS excluded. Never assume swing performance from scalping.",scalpingLearningNote:"Reuse empirically supported SMC patterns as hypotheses, never assume scalping WR transfers to swing. Prefer fresh POI, reachability, liquidity sweep, displacement, BOS/MSS, HTF alignment. No execution."};
  if(!process.env.OPENAI_API_KEY){console.warn("SWING_OPENAI_NOT_CONFIGURED");return;}
  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const result=await client.responses.create({model:process.env.OPENAI_MODEL||"gpt-5.6",instructions:"Anda adalah analis swing XAUUSD berbahasa Indonesia. W1 adalah konteks, H4 trigger, H1 konfirmasi, M15 entry. Analisa candle closed, jangan mengarang data. Cari aktif setidaknya satu kandidat entry valid setiap sesi Asia, London, New York; bandingkan POI, sweep, BOS/MSS, breakout-retest. Pilih BUY, SELL, atau NO_TRADE hanya jika tidak ada kandidat valid. Semua setup BUY/SELL wajib RR tepat 1:2 tanpa batas SL tetap dan harga SL berdasarkan invalidasi struktur. Wajib bukti struktur, liquidity sweep/displacement, MSS/BOS, fresh POI yang dapat terjemput, SL di invalidasi struktur, TP berbasis likuiditas. Jangan memaksa entry, jangan mengklaim probabilitas terkalibrasi atau winrate swing sebelum ada sampel. Output JSON valid saja dengan fields decision,weeklyBias,h4Trigger,h1Confirmation,m15Entry,setup,entry,stopLoss,tp1,tp2,tp3,reason,invalidation,confidence,learningNotes. Untuk NO_TRADE harga null. Ini hanya paper signal, bukan perintah order.",input:JSON.stringify(input)});
  let obj;try{obj=JSON.parse(result.output_text.replace(/^```(?:json)?\s*|\s*```$/g,""));}catch{console.error("SWING_INVALID_AI_JSON");return;}
  if(!["BUY","SELL","NO_TRADE"].includes(obj.decision))return;
  if(obj.decision!=="NO_TRADE"){
   const e=Number(obj.entry),sl=Number(obj.stopLoss),risk=Math.abs(e-sl),direction=obj.decision==="BUY"?1:-1;
   if(!Number.isFinite(e)||!Number.isFinite(sl)||risk<=0||(direction===1&&sl>=e)||(direction===-1&&sl<=e)){console.error("SWING_INVALID_RISK");return;}
   const target=e+direction*2*risk;
   if(!Number.isFinite(Number(obj.tp2))||Math.abs(Number(obj.tp2)-target)>Math.max(0.002,risk*0.001)){console.error("SWING_INVALID_RR",JSON.stringify({id,expected:target,received:obj.tp2}));return;}
   if(!obj.h1Confirmation||!obj.m15Entry||!obj.invalidation){console.error("SWING_MISSING_CONFIRMATION",JSON.stringify({id}));return;}
   obj.tp2=target;
   obj.tp1=e+direction*risk;
  }
  await pool.query("INSERT INTO swing_analysis(id,symbol,trigger_time,decision,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[id,symbol,iso(last),obj.decision,JSON.stringify(obj)]);
  await registerSwing(id,symbol,obj);
  await notifySwing(id,symbol,iso(last),obj).catch(e=>console.error("SWING_NOTIFY_ERROR",e.message));
  console.log("SWING_OPENAI_SUCCESS",JSON.stringify({id,decision:obj.decision}));
 }catch(e){console.error("SWING_OPENAI_ERROR",String(e.message).slice(0,300));}finally{inFlight.delete(id);}
}
export async function getSwingStatus(){await init();const r=await pool.query("SELECT a.id,a.trigger_time,a.decision,a.payload,a.created_at,o.status,o.entry_at,o.closed_at,o.pnl_r FROM swing_analysis a LEFT JOIN swing_outcomes o ON o.signal_id=a.id WHERE a.symbol='XAUUSD' ORDER BY a.trigger_time DESC LIMIT 50");const c=await pool.query("SELECT timeframe,MAX(candle_time) AS latest,COUNT(*)::int AS samples FROM swing_candles WHERE symbol='XAUUSD' GROUP BY timeframe");return{mode:"SIGNAL_ONLY",executionEnabled:false,history:r.rows,feed:c.rows,learning:await swingMetrics("XAUUSD")};}
