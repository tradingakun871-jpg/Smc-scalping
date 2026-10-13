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
