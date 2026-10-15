import pg from "pg";
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
let ready;
async function init(){
 if(!ready)ready=pool.query("CREATE TABLE IF NOT EXISTS swing_outcomes (signal_id TEXT PRIMARY KEY REFERENCES swing_analysis(id),symbol TEXT NOT NULL,side TEXT NOT NULL,entry FLOAT8 NOT NULL,sl FLOAT8 NOT NULL,tp1 FLOAT8 NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',entry_at TIMESTAMPTZ,closed_at TIMESTAMPTZ,pnl_r FLOAT8,last_candle TIMESTAMPTZ)");
 await ready;
}
export async function registerSwing(id,symbol,x){
 if(!["BUY","SELL"].includes(x.decision))return;
 const e=Number(x.entry),s=Number(x.stopLoss),t=Number(x.tp1),buy=x.decision==="BUY";
 if(![e,s,t].every(Number.isFinite)||!(buy?s<e&&t>e:s>e&&t<e))return;
 await init();
 await pool.query("INSERT INTO swing_outcomes(signal_id,symbol,side,entry,sl,tp1) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[id,symbol,x.decision,e,s,t]);
}
export async function swingMetrics(symbol="XAUUSD"){
 await init();
 const q=await pool.query("SELECT status,COUNT(*)::int AS n FROM swing_outcomes WHERE symbol=$1 GROUP BY status",[symbol]);
 const c=Object.fromEntries(q.rows.map(x=>[x.status,x.n]));
 const wins=c.TP1||0,losses=c.SL||0,n=wins+losses;
 return{finalSamples:n,wins,losses,winRatePct:n?+(wins*100/n).toFixed(2):null,profitFactor:losses?+(wins/losses).toFixed(3):null,netR:wins-losses,pending:c.PENDING||0,active:c.ACTIVE||0,cancelled:c.CANCELLED||0,ambiguous:c.AMBIGUOUS||0,calibrated:n>=100};
}

export async function trackSwing(symbol,candles=[],timeframe="M15"){
 await init();
 const bars=candles.filter(c=>c.closed!==false&&c.time&&[c.open,c.high,c.low,c.close].every(v=>Number.isFinite(Number(v)))).sort((a,b)=>new Date(a.time)-new Date(b.time));
 if(!bars.length)return;
 const q=await pool.query("SELECT o.*,a.created_at FROM swing_outcomes o JOIN swing_analysis a ON a.id=o.signal_id WHERE o.symbol=$1 AND o.status IN ('PENDING','ACTIVE')",[symbol]);
 for(const o of q.rows){
  let status=o.status,entryAt=o.entry_at,closedAt=null,pnl=null,last=o.last_candle?new Date(o.last_candle):new Date(o.created_at);
  for(const c of bars){
   const t=new Date(c.time);
   const closedAtTime=new Date(t.getTime()+(timeframe==="M1"?60000:timeframe==="M5"?300000:900000));
   if(closedAtTime<=last||closedAtTime<=new Date(o.created_at))continue;
   last=closedAtTime;
   const buy=o.side==="BUY",touch=level=>Number(c.low)<=level&&Number(c.high)>=level;
   const hitSl=buy?Number(c.low)<=o.sl:Number(c.high)>=o.sl;
   const hitTp=buy?Number(c.high)>=o.tp1:Number(c.low)<=o.tp1;
   if(status==="PENDING"&&touch(o.entry)){
    if(hitSl||hitTp){status="AMBIGUOUS";closedAt=closedAtTime;break;}
    status="ACTIVE";entryAt=closedAtTime;
   }else if(status==="ACTIVE"){
    if(hitSl&&hitTp){status="AMBIGUOUS";closedAt=t;break;}
    if(hitSl||hitTp){status=hitSl?"SL":"TP1";closedAt=t;pnl=hitSl?-1:1;break;}
   }
  }
  if(status==="PENDING"&&last.getTime()-new Date(o.created_at).getTime()>=7*86400000){status="CANCELLED";closedAt=last;}
  if(last>new Date(o.last_candle||o.created_at)){
   await pool.query("UPDATE swing_outcomes SET status=$2,entry_at=$3,closed_at=$4,pnl_r=$5,last_candle=$6 WHERE signal_id=$1 AND status=$7",[o.signal_id,status,entryAt,closedAt,pnl,last,o.status]);
   if(status!==o.status)console.log("SWING_OUTCOME",JSON.stringify({id:o.signal_id,from:o.status,status,pnl,source:timeframe}));
  }
 }
}
