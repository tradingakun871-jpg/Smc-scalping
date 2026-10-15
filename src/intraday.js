import pg from "pg";
import OpenAI from "openai";
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL,max:2}):null;
const busy=new Set();
let ready;
const init=()=>ready??=(async()=>{if(!pool)throw Error("INTRADAY_DB_UNAVAILABLE");await pool.query(`CREATE TABLE IF NOT EXISTS intraday_signals(id TEXT PRIMARY KEY,symbol TEXT NOT NULL,session TEXT NOT NULL,session_date TEXT NOT NULL,decision TEXT NOT NULL,status TEXT NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),triggered_at TIMESTAMPTZ,closed_at TIMESTAMPTZ)`);})();
const clean=(xs,n)=>Array.isArray(xs)?xs.slice(-n).filter(x=>x&&x.closed!==false&&x.time&&Number.isFinite(Date.parse(x.time))&&["open","high","low","close"].every(k=>Number.isFinite(Number(x[k])))).map(x=>({time:x.time,open:+x.open,high:+x.high,low:+x.low,close:+x.close})):[];
const wib=(d,options)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta",...options}).format(d);

async function sendIntradayTelegram(id,session,decision,status,x){
 const token=process.env.TELEGRAM_BOT_TOKEN;
 const ids=[process.env.TELEGRAM_CHAT_ID,process.env.TELEGRAM_GROUP_CHAT_ID].flatMap(v=>String(v||"").split(",")).map(v=>v.trim()).filter(Boolean);
 if(!token||!ids.length){console.error("INTRADAY_TELEGRAM_NOT_CONFIGURED",id);return;}
 const msg=["📊 AI INTRADAY XAUUSD", "Sesi: "+session, "Keputusan: "+decision, "Status: "+status, "Entry: "+(x.entry??"—"), "SL: "+(x.stopLoss??"—"), "TP1 (1R): "+(x.tp1??"—"), "TP2 (2R): "+(x.tp2??"—"), "Confidence: "+(x.confidence??"—")+"%", "Alasan: "+String(x.reason||"—").slice(0,700), "Waktu: "+new Date().toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})+" WIB"].join("\n");
 for(const chatId of [...new Set(ids)]){try{const resp=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:msg}),signal:AbortSignal.timeout(10000)});const body=await resp.json().catch(()=>({}));if(!resp.ok||!body.ok)console.error("INTRADAY_TELEGRAM_FAILED",JSON.stringify({id,http:resp.status,description:String(body.description||"").slice(0,140)}));else console.log("INTRADAY_TELEGRAM_SENT",JSON.stringify({id}));}catch(e){console.error("INTRADAY_TELEGRAM_FAILED",JSON.stringify({id,error:String(e.message).slice(0,140)}));}}
}
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
  if(!["BUY","SELL"].includes(side)||![e,sl,tp].every(Number.isFinite))continue;
  let status=o.status,triggeredAt=null,closedAt=null;
  const bars=(data.m5.length?data.m5:data.m15).filter(bar=>new Date(Date.parse(bar.time)+300000)>new Date(o.created_at)).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  for(const bar of bars){
   const t=new Date(bar.time),hitEntry=bar.low<=e&&bar.high>=e,hitSL=side==="BUY"?bar.low<=sl:bar.high>=sl,hitTP=side==="BUY"?bar.high>=tp:bar.low<=tp;
   if(status==="VALID_PENDING"){
    if(!hitEntry)continue;
    status="TRIGGERED";triggeredAt=t;
    if(hitSL||hitTP){status="CANCELLED";closedAt=t;break;} // OHLC cannot establish which level was touched first.
    continue;
   }
   if(status==="TRIGGERED"&&(hitSL||hitTP)){
    status=hitSL&&hitTP?"CANCELLED":hitSL?"SL":"TP2";closedAt=t;break;
   }
  }
  if(status==="VALID_PENDING"&&Date.now()-new Date(o.created_at).getTime()>12*3600000){status="EXPIRED";closedAt=new Date();}
  if(status!==o.status){
   await pool.query("UPDATE intraday_signals SET status=$2,triggered_at=COALESCE(triggered_at,$3),closed_at=COALESCE(closed_at,$4) WHERE id=$1 AND status=$5",[o.id,status,triggeredAt,closedAt,o.status]);
   console.log("INTRADAY_STATUS_CHANGE",JSON.stringify({id:o.id,from:o.status,to:status,source:data.m5.length?"M5":"M15"}));
  }
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
  await sendIntradayTelegram(id,session,x.decision,status,x);
 }catch(e){console.error("INTRADAY_ANALYSIS_ERROR",String(e.message).slice(0,240));}finally{busy.delete(id);}
}
export async function updateIntradayFromM5(symbol,candle){
 await init();
 const t=new Date(candle?.time),lo=Number(candle?.low),hi=Number(candle?.high);
 if(!Number.isFinite(t.getTime())||![lo,hi].every(Number.isFinite)||lo>hi)return;
 const rows=await pool.query("SELECT id,decision,status,payload,created_at FROM intraday_signals WHERE symbol=$1 AND status IN ('VALID_PENDING','TRIGGERED') FOR UPDATE SKIP LOCKED",[symbol]);
 for(const row of rows.rows){
  const created=new Date(row.created_at),end=new Date(t.getTime()+300000);
  if(end<=created)continue;
  const x=row.payload,e=Number(x.entry),sl=Number(x.stopLoss),tp=Number(x.tp2),side=row.decision;
  if(!["BUY","SELL"].includes(side)||![e,sl,tp].every(Number.isFinite))continue;
  const entry=lo<=e&&hi>=e,hitSL=side==="BUY"?lo<=sl:hi>=sl,hitTP=side==="BUY"?hi>=tp:lo<=tp;
  let status=row.status,triggeredAt=null,closedAt=null;
  if(status==="VALID_PENDING"&&entry){
   triggeredAt=end;status=hitSL||hitTP?"CANCELLED":"TRIGGERED";
   if(status==="CANCELLED")closedAt=end;
  }else if(status==="TRIGGERED"&&(hitSL||hitTP)){status=hitSL&&hitTP?"CANCELLED":hitSL?"SL":"TP2";closedAt=end;}
  if(status==="VALID_PENDING"&&Date.now()-created.getTime()>12*3600000){status="EXPIRED";closedAt=new Date();}
  if(status!==row.status){
   const updated=await pool.query("UPDATE intraday_signals SET status=$2,triggered_at=COALESCE(triggered_at,$3),closed_at=COALESCE(closed_at,$4) WHERE id=$1 AND status=$5",[row.id,status,triggeredAt,closedAt,row.status]);
   if(updated.rowCount)console.log("INTRADAY_STATUS_CHANGE",JSON.stringify({id:row.id,from:row.status,to:status,source:"M5_INGEST",candleTime:t.toISOString()}));
  }
 }
}
export async function getIntradayStatus(){await init();const r=await pool.query("SELECT id,session,session_date,decision,status,payload,created_at,triggered_at,closed_at FROM intraday_signals WHERE symbol='XAUUSD' ORDER BY created_at DESC LIMIT 60");return{mode:"INTRADAY_SIGNAL_ONLY",executionEnabled:false,history:r.rows};}
