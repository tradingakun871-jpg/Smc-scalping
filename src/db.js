import pg from "pg";
const {Pool}=pg;
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
export async function checkDb(){if(!pool)return false;const r=await pool.query("SELECT 1 AS ok");return r.rows[0]?.ok===1}
export async function initDb(){if(!pool)return false;await pool.query("CREATE TABLE IF NOT EXISTS service_heartbeat (service TEXT PRIMARY KEY,last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");await pool.query("CREATE TABLE IF NOT EXISTS m5_candles (symbol TEXT NOT NULL,candle_time TIMESTAMPTZ NOT NULL,payload JSONB NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(symbol,candle_time))");await pool.query("CREATE INDEX IF NOT EXISTS idx_m5_symbol_time ON m5_candles(symbol,candle_time DESC)");await pool.query(`CREATE TABLE IF NOT EXISTS trade_results (hourly_id TEXT PRIMARY KEY,symbol TEXT NOT NULL,side TEXT NOT NULL,entry DOUBLE PRECISION NOT NULL,stop_loss DOUBLE PRECISION NOT NULL,tp1 DOUBLE PRECISION NOT NULL,tp2 DOUBLE PRECISION NOT NULL,confidence DOUBLE PRECISION,signal_time TIMESTAMPTZ NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',exit_price DOUBLE PRECISION,pnl_points DOUBLE PRECISION,closed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);await pool.query("ALTER TABLE trade_results ADD COLUMN IF NOT EXISTS entry_touched BOOLEAN NOT NULL DEFAULT FALSE");return true}
export async function saveTradeSignal(t){if(!pool)return false;await pool.query("INSERT INTO trade_results(hourly_id,symbol,side,entry,stop_loss,tp1,tp2,confidence,signal_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(hourly_id) DO NOTHING",[t.hourlyId,t.symbol,t.side,t.entry,t.stopLoss,t.tp1,t.tp2,t.confidence??null,t.signalTime]);return true}
export async function updateOpenTrades(symbol,candle){if(!pool)return[];const r=await pool.query("SELECT * FROM trade_results WHERE symbol=$1 AND status='OPEN' ORDER BY signal_time",[symbol]);const out=[];for(const t of r.rows){const hi=+candle.high,lo=+candle.low,entry=+t.entry,sl=+t.stop_loss,tp1=+t.tp1,tp2=+t.tp2;const entryTouched=lo<=entry&&hi>=entry;if(!entryTouched)continue;let status=null,exit=null;if(t.side==="BUY"){const hitSL=lo<=sl,hitTP2=hi>=tp2,hitTP1=hi>=tp1;if(hitSL&&(hitTP1||hitTP2))continue;if(hitTP2){status="TP2";exit=tp2}else if(hitTP1){status="TP1";exit=tp1}else if(hitSL){status="SL";exit=sl}}else{const hitSL=hi>=sl,hitTP2=lo<=tp2,hitTP1=lo<=tp1;if(hitSL&&(hitTP1||hitTP2))continue;if(hitTP2){status="TP2";exit=tp2}else if(hitTP1){status="TP1";exit=tp1}else if(hitSL){status="SL";exit=sl}}if(status){const pnl=t.side==="BUY"?exit-entry:entry-exit;await pool.query("UPDATE trade_results SET status=$2,exit_price=$3,pnl_points=$4,closed_at=NOW() WHERE hourly_id=$1",[t.hourly_id,status,exit,pnl]);out.push({...t,status,exit_price:exit,pnl_points:pnl})}}return out}
export async function updateOpenTradesFromPrice(symbol,price){
 if(!pool||!Number.isFinite(+price))return[];
 const px=+price;
 const r=await pool.query("SELECT * FROM trade_results WHERE symbol=$1 AND status IN ('PENDING','ACTIVE') ORDER BY signal_time",[symbol]);
 const out=[];
 for(const t of r.rows){
  const entry=+t.entry,sl=+t.stop_loss,tp1=+t.tp1,tp2=+t.tp2;
  let active=t.status==="ACTIVE"||!!t.entry_touched;
  if(!active){
   active=t.side==="BUY"?px<=entry:px>=entry;
   if(active){
    const a=await pool.query("UPDATE trade_results SET entry_touched=TRUE,status='ACTIVE' WHERE hourly_id=$1 AND status='PENDING' RETURNING *",[t.hourly_id]);
    if(a.rowCount)out.push({event:"ACTIVE",...a.rows[0]});
   }
  }
  if(!active)continue;
  let status=null,exit=null;
  if(t.side==="BUY"){
   if(px<=sl){status="SL";exit=sl}
   else if(px>=tp2){status="TP2";exit=tp2}
   else if(px>=tp1){status="TP1";exit=tp1}
  }else{
   if(px>=sl){status="SL";exit=sl}
   else if(px<=tp2){status="TP2";exit=tp2}
   else if(px<=tp1){status="TP1";exit=tp1}
  }
  if(status){
   const pnl=t.side==="BUY"?exit-entry:entry-exit;
   const q=await pool.query("UPDATE trade_results SET status=$2,exit_price=$3,pnl_points=$4,closed_at=NOW() WHERE hourly_id=$1 AND status='ACTIVE' RETURNING *",[t.hourly_id,status,exit,pnl]);
   if(q.rowCount)out.push({event:status,...q.rows[0]});
  }
 }
 return out
}
export async function expirePendingTrades(symbol,newHour){if(!pool)return[];const r=await pool.query("UPDATE trade_results SET status='FAILED',closed_at=NOW() WHERE symbol=$1 AND status='PENDING' AND entry_touched=FALSE AND signal_time < $2 RETURNING *",[symbol,new Date(newHour).toISOString()]);return r.rows}
export async function getTradeStats(symbol){if(!pool)return null;const r=await pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='OPEN')::int open,COUNT(*) FILTER(WHERE status IN ('TP1','TP2'))::int wins,COUNT(*) FILTER(WHERE status='SL')::int losses,COUNT(*) FILTER(WHERE status='TP1')::int tp1,COUNT(*) FILTER(WHERE status='TP2')::int tp2,COALESCE(SUM(pnl_points) FILTER(WHERE status<>'OPEN'),0)::float pnl_points FROM trade_results WHERE symbol=$1",[symbol]);const s=r.rows[0],closed=s.wins+s.losses;return {...s,closed,winrate:closed?+(s.wins*100/closed).toFixed(2):0}}
export async function touchHeartbeat(service="MT5"){if(!pool)return false;await pool.query("INSERT INTO service_heartbeat(service,last_seen_at) VALUES($1,NOW()) ON CONFLICT(service) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at",[service]);return true}
export async function getHeartbeat(service="MT5"){if(!pool)return null;const r=await pool.query("SELECT last_seen_at FROM service_heartbeat WHERE service=$1",[service]);return r.rows[0]?.last_seen_at||null}
export async function saveM5Candle(symbol,candle){if(!pool)return false;await pool.query("INSERT INTO m5_candles(symbol,candle_time,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(symbol,candle_time) DO UPDATE SET payload=EXCLUDED.payload,received_at=NOW()",[symbol,new Date(candle.time).toISOString(),JSON.stringify(candle)]);return true}
export async function getM5Block(symbol,blockStart){if(!pool)return[];const start=new Date(blockStart),end=new Date(start.getTime()+60*60*1000);const r=await pool.query("SELECT payload FROM m5_candles WHERE symbol=$1 AND candle_time >= $2 AND candle_time < $3 ORDER BY candle_time ASC",[symbol,start.toISOString(),end.toISOString()]);return r.rows.map(x=>x.payload)}
export async function getCurrentM5Count(symbol,now=new Date()){if(!pool)return null;const start=new Date(now);start.setUTCMinutes(0,0,0);const r=await pool.query("SELECT COUNT(*)::int AS n FROM m5_candles WHERE symbol=$1 AND candle_time >= $2 AND candle_time < $3",[symbol,start.toISOString(),new Date(start.getTime()+3600000).toISOString()]);return r.rows[0]?.n??0}

export async function getTradeJournal(symbol,period="daily",date=new Date().toISOString().slice(0,10)){if(!pool)return null;const unit=period==="monthly"?"month":"day";const r=await pool.query(`SELECT hourly_id,symbol,side,entry,stop_loss,tp1,tp2,confidence,signal_time,status,exit_price,pnl_points,closed_at FROM trade_results WHERE symbol=$1 AND signal_time >= date_trunc('${unit}',$2::timestamptz) AND signal_time < date_trunc('${unit}',$2::timestamptz)+INTERVAL '1 ${unit}' ORDER BY signal_time DESC, created_at DESC`,[symbol,date+"T00:00:00Z"]);const rows=r.rows;const closed=rows.filter(t=>t.status!=="OPEN"),wins=closed.filter(t=>t.status==="TP1"||t.status==="TP2").length,losses=closed.filter(t=>t.status==="SL").length;return{period,date,total:rows.length,open:rows.filter(t=>t.status==="OPEN").length,tp1:rows.filter(t=>t.status==="TP1").length,tp2:rows.filter(t=>t.status==="TP2").length,sl:losses,closed:closed.length,wins,losses,winrate:closed.length?+(wins*100/closed.length).toFixed(2):0,pnlPoints:+rows.reduce((a,t)=>a+(+t.pnl_points||0),0).toFixed(2),trades:rows}}

export async function getLatestOpenTrade(symbol){if(!pool)return null;const r=await pool.query("SELECT hourly_id,symbol,side,entry,stop_loss,tp1,tp2,confidence,signal_time,status FROM trade_results WHERE symbol=$1 AND status='OPEN' ORDER BY signal_time DESC LIMIT 1",[symbol]);return r.rows[0]||null}

export async function hasTradeSignal(hourlyId){if(!pool)return false;const r=await pool.query("SELECT 1 FROM trade_results WHERE hourly_id=$1 LIMIT 1",[hourlyId]);return r.rowCount>0}
export async function normalizeLegacyHourlySignals(symbol){if(!pool)return 0;const r=await pool.query("SELECT hourly_id,signal_time FROM trade_results WHERE symbol=$1 ORDER BY signal_time",[symbol]);let changed=0;for(const t of r.rows){const slot=new Date(t.signal_time);if(slot.getUTCMinutes()===0&&slot.getUTCSeconds()===0)continue;slot.setUTCMinutes(0,0,0);const newId=symbol+":"+slot.toISOString();const exists=await pool.query("SELECT 1 FROM trade_results WHERE hourly_id=$1",[newId]);if(exists.rowCount){await pool.query("DELETE FROM trade_results WHERE hourly_id=$1",[t.hourly_id])}else{await pool.query("UPDATE trade_results SET hourly_id=$2,signal_time=$3 WHERE hourly_id=$1",[t.hourly_id,newId,slot.toISOString()])}changed++}return changed}

export async function getLatestTrade(symbol){if(!pool)return null;const r=await pool.query("SELECT hourly_id,symbol,side,entry,stop_loss,tp1,tp2,confidence,signal_time,status,exit_price,pnl_points,closed_at FROM trade_results WHERE symbol=$1 ORDER BY signal_time DESC,created_at DESC LIMIT 1",[symbol]);return r.rows[0]||null}
