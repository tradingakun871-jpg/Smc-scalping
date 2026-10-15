import pg from "pg";
import OpenAI from "openai";
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL,max:2}):null;
const busy=new Set();
let ready;
const init=()=>ready??=(async()=>{if(!pool)throw Error("INTRADAY_DB_UNAVAILABLE");await pool.query(`CREATE TABLE IF NOT EXISTS intraday_signals(id TEXT PRIMARY KEY,symbol TEXT NOT NULL,session TEXT NOT NULL,session_date TEXT NOT NULL,decision TEXT NOT NULL,status TEXT NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),triggered_at TIMESTAMPTZ,closed_at TIMESTAMPTZ)`);})();
const clean=(xs,n)=>Array.isArray(xs)?xs.slice(-n).filter(x=>x&&x.closed!==false&&x.time&&Number.isFinite(Date.parse(x.time))&&["open","high","low","close"].every(k=>Number.isFinite(Number(x[k])))).map(x=>({time:x.time,open:+x.open,high:+x.high,low:+x.low,close:+x.close})):[];
const wib=(d,options)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta",...options}).format(d);
export async function ingestIntraday({symbol="XAUUSD",d1,h4=[],h1=[],m15=[],m5=[]}){
 const data={d1:d1&&d1.closed!==false?d1:null,h4:clean(h4,80),h1:clean(h1,48),m15:clean(m15,96),m5:clean(m5,100)};
 if(!data.d1||data.h4.length<12||data.h1.length<12||data.m15.length<20){console.warn("INTRADAY_DATA_INCOMPLETE",JSON.stringify({symbol,h4:data.h4.length,h1:data.h1.length,m15:data.m15.length}));return;}
 await init();
 const last=data.h1.at(-1),now=new Date(last.time),age=Date.now()-now.getTime();
 if(age<0||age>3*3600000){console.warn("INTRADAY_STALE_H1",JSON.stringify({symbol,age}));return;}
 const hour=Number(wib(now,{hour:"2-digit",hourCycle:"h23"}));
 const session=hour>=20||hour<5?"NEW_YORK":hour>=14?"LONDON":"ASIA";
 const day=wib(now,{year:"numeric",month:"2-digit",day:"2-digit"});
 const id=symbol+":INTRADAY:"+day+":"+session;
 const pending=await pool.query("SELECT id,status,payload,created_at FROM intraday_signals WHERE symbol=$1 AND status IN ('VALID_PENDING','TRIGGERED')",[symbol]);
 for(const o of pending.rows){
  const x=o.payload,side=x.decision,e=Number(x.entry),sl=Number(x.stopLoss),tp=Number(x.tp2);
  let status=o.status,at=null;
  for(const bar of data.m15){
   const t=new Date(bar.time);if(t<=new Date(o.created_at))continue;
   const hitEntry=bar.low<=e&&bar.high>=e,hitSL=side==="BUY"?bar.low<=sl:bar.high>=sl,hitTP=side==="BUY"?bar.high>=tp:bar.low<=tp;
   if(status==="VALID_PENDING"&&hitEntry){status="TRIGGERED";at=t;}
   if(status==="TRIGGERED"&&(hitSL||hitTP)){status=hitSL&&hitTP?"CANCELLED":hitSL?"SL":"TP2";at=t;break;}
  }
  if(status==="VALID_PENDING"&&Date.now()-new Date(o.created_at).getTime()>12*3600000){status="EXPIRED";at=new Date();}
  if(status!==o.status)await pool.query("UPDATE intraday_signals SET status=$2,triggered_at=CASE WHEN $2='TRIGGERED' THEN $3 ELSE triggered_at END,closed_at=CASE WHEN $2 IN ('SL','TP2','CANCELLED','EXPIRED') THEN $3 ELSE closed_at END WHERE id=$1",[o.id,status,at]);
 }
 if((await pool.query("SELECT 1 FROM intraday_signals WHERE id=$1",[id])).rowCount||busy.has(id))return;
 busy.add(id);
 try{
  if(!process.env.OPENAI_API_KEY){console.error("INTRADAY_OPENAI_MISSING");return;}
  const history=await pool.query("SELECT decision,status,payload->>'reason' AS reason FROM intraday_signals WHERE symbol=$1 ORDER BY created_at DESC LIMIT 40",[symbol]);
  const ai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const response=await ai.responses.create({model:process.env.OPENAI_MODEL||"gpt-5.6",instructions:"Anda analis Intraday XAUUSD, terpisah dari scalping. D1 konteks, H4 arah, H1 trigger, M15 entry, M5 refinement. Setiap sesi Asia/London/New York cari aktif minimal satu kandidat BUY/SELL yang valid menggunakan POI, sweep, MSS/BOS, breakout retest, supply demand. Entry pending boleh belum tersentuh. Hanya candle closed, POI fresh dan reachable, konfirmasi H1/M15 dan invalidasi struktural jelas. SL dinamis berdasarkan struktur/liquidity, tanpa batas pips tetap. TP2 wajib tepat RR 1:2. Jangan buat harga atau bukti fiktif. Jika tidak ada setup valid gunakan NO_TRADE dan jelaskan alasan. Output JSON saja: decision,entry,stopLoss,tp1,tp2,confidence,setup,reason,h1Confirmation,m15Confirmation,invalidation.",input:JSON.stringify({symbol,session,day,data,history:history.rows})});
  let x;try{x=JSON.parse(response.output_text.replace(/^```(?:json)?\s*|\s*```$/g,""));}catch{console.error("INTRADAY_INVALID_JSON",id);return;}
  if(!["BUY","SELL","NO_TRADE"].includes(x.decision))return;
  let status="NO_VALID_SETUP";
  if(x.decision!=="NO_TRADE"){
   const e=Number(x.entry),sl=Number(x.stopLoss),risk=Math.abs(e-sl),dir=x.decision==="BUY"?1:-1;
   const expected=e+dir*2*risk;
   if(![e,sl,Number(x.tp2)].every(Number.isFinite)||risk<=0||dir*(e-sl)<=0||Math.abs(Number(x.tp2)-expected)>Math.max(.002,risk*.001)||!x.h1Confirmation||!x.m15Confirmation||!x.invalidation){console.error("INTRADAY_HARD_GUARD_REJECT",JSON.stringify({id,reason:"INVALID_RR_OR_STRUCTURE"}));return;}
   x.tp1=e+dir*risk;x.tp2=expected;status="VALID_PENDING";
  }
  await pool.query("INSERT INTO intraday_signals(id,symbol,session,session_date,decision,status,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",[id,symbol,session,day,x.decision,status,JSON.stringify(x)]);
  console.log("INTRADAY_SESSION_DECISION",JSON.stringify({id,decision:x.decision,status}));
 }catch(e){console.error("INTRADAY_ANALYSIS_ERROR",String(e.message).slice(0,240));}finally{busy.delete(id);}
}
export async function getIntradayStatus(){await init();const r=await pool.query("SELECT id,session,session_date,decision,status,payload,created_at,triggered_at,closed_at FROM intraday_signals WHERE symbol='XAUUSD' ORDER BY created_at DESC LIMIT 60");return{mode:"INTRADAY_SIGNAL_ONLY",executionEnabled:false,history:r.rows};}
