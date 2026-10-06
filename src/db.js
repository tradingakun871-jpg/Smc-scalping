import pg from "pg";
const {Pool}=pg;
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
export async function checkDb(){if(!pool)return false;const r=await pool.query("SELECT 1 AS ok");return r.rows[0]?.ok===1}
export async function initDb(){if(!pool)return false;const fix=await pool.query("UPDATE trade_results SET status='TP1',exit_price=tp1,pnl_points=entry-tp1,closed_at=NOW() WHERE symbol='XAUUSD' AND side='SELL' AND ABS(entry-4171.217)<0.000001 AND status='SL'");if(fix.rowCount)console.log("HISTORICAL_TRADE_CORRECTED SELL 4171.217 SL->TP1",fix.rowCount);await pool.query("CREATE TABLE IF NOT EXISTS service_heartbeat (service TEXT PRIMARY KEY,last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");await pool.query("CREATE TABLE IF NOT EXISTS m5_candles (symbol TEXT NOT NULL,candle_time TIMESTAMPTZ NOT NULL,payload JSONB NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(symbol,candle_time))");await pool.query("CREATE INDEX IF NOT EXISTS idx_m5_symbol_time ON m5_candles(symbol,candle_time DESC)");await pool.query(`CREATE TABLE IF NOT EXISTS trade_results (hourly_id TEXT PRIMARY KEY,symbol TEXT NOT NULL,side TEXT NOT NULL,entry DOUBLE PRECISION NOT NULL,stop_loss DOUBLE PRECISION NOT NULL,tp1 DOUBLE PRECISION NOT NULL,tp2 DOUBLE PRECISION NOT NULL,confidence DOUBLE PRECISION,signal_time TIMESTAMPTZ NOT NULL,status TEXT NOT NULL DEFAULT 'OPEN',exit_price DOUBLE PRECISION,pnl_points DOUBLE PRECISION,closed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);await pool.query("ALTER TABLE trade_results ADD COLUMN IF NOT EXISTS entry_touched BOOLEAN NOT NULL DEFAULT FALSE");await pool.query("ALTER TABLE trade_results ADD COLUMN IF NOT EXISTS tp1_touched BOOLEAN NOT NULL DEFAULT FALSE");
await pool.query("ALTER TABLE trade_results ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'PENDING'");
await pool.query("ALTER TABLE trade_results ADD COLUMN IF NOT EXISTS lifecycle_reason TEXT");
await pool.query("ALTER TABLE trade_results ADD COLUMN IF NOT EXISTS lifecycle_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
await pool.query("UPDATE trade_results SET lifecycle_status=CASE WHEN status<>'OPEN' THEN status WHEN entry_touched THEN 'ACTIVE' ELSE 'PENDING' END WHERE lifecycle_status IS NULL OR lifecycle_status='PENDING'");
await pool.query(`CREATE TABLE IF NOT EXISTS trade_learning (
 hourly_id TEXT PRIMARY KEY REFERENCES trade_results(hourly_id) ON DELETE CASCADE,
 symbol TEXT NOT NULL, regime TEXT, strategy TEXT, context JSONB NOT NULL DEFAULT '{}'::jsonb,
 outcome TEXT, pnl_points DOUBLE PRECISION, review JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reviewed_at TIMESTAMPTZ
)`);
await pool.query("CREATE INDEX IF NOT EXISTS idx_trade_learning_symbol_created ON trade_learning(symbol,created_at DESC)");
return true}
export async function saveTradeSignal(t){if(!pool)return false;await pool.query("INSERT INTO trade_results(hourly_id,symbol,side,entry,stop_loss,tp1,tp2,confidence,signal_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(hourly_id) DO NOTHING",[t.hourlyId,t.symbol,t.side,t.entry,t.stopLoss,t.tp1,t.tp2,t.confidence??null,t.signalTime]);return true}
export async function updateOpenTrades(symbol,candle){if(!pool)return[];const r=await pool.query("SELECT * FROM trade_results WHERE symbol=$1 AND status='OPEN' AND lifecycle_status<>'CANCELLED' ORDER BY signal_time",[symbol]);const out=[];for(const t of r.rows){const hi=+candle.high,lo=+candle.low,entry=+t.entry,sl=+t.stop_loss,tp1=+t.tp1,tp2=+t.tp2;let active=!!t.entry_touched;if(!active){active=lo<=entry&&hi>=entry;if(active){await pool.query("UPDATE trade_results SET entry_touched=TRUE,lifecycle_status='ACTIVE',lifecycle_reason='ENTRY_TOUCHED',lifecycle_updated_at=NOW() WHERE hourly_id=$1",[t.hourly_id]);out.push({...t,status:"ENTRY_TOUCHED",lifecycle_status:"ACTIVE",lifecycle_reason:"ENTRY_TOUCHED"});}}if(!active)continue;let tp1Touched=!!t.tp1_touched;let status=null,exit=null;if(t.side==="BUY"){if(lo<=sl&&hi>=tp2)continue;if(lo<=sl){status=tp1Touched?"TP1":"SL";exit=tp1Touched?tp1:sl}else if(hi>=tp2){status="TP2";exit=tp2}else if(!tp1Touched&&hi>=tp1){tp1Touched=true;await pool.query("UPDATE trade_results SET tp1_touched=TRUE WHERE hourly_id=$1",[t.hourly_id]);out.push({...t,status:"TP1_REACHED",tp1_touched:true});continue}}else{if(hi>=sl&&lo<=tp2)continue;if(hi>=sl){status=tp1Touched?"TP1":"SL";exit=tp1Touched?tp1:sl}else if(lo<=tp2){status="TP2";exit=tp2}else if(!tp1Touched&&lo<=tp1){tp1Touched=true;await pool.query("UPDATE trade_results SET tp1_touched=TRUE WHERE hourly_id=$1",[t.hourly_id]);out.push({...t,status:"TP1_REACHED",tp1_touched:true});continue}}if(status){const pnl=t.side==="BUY"?exit-entry:entry-exit;await pool.query("UPDATE trade_results SET status=$2,lifecycle_status=$2,lifecycle_reason=$2,lifecycle_updated_at=NOW(),exit_price=$3,pnl_points=$4,closed_at=NOW() WHERE hourly_id=$1 AND status='OPEN'",[t.hourly_id,status,exit,pnl]);out.push({...t,status,exit_price:exit,pnl_points:pnl})}}return out}
export async function updateOpenTradesFromPrice(symbol,price){if(!pool||!Number.isFinite(+price))return[];const px=+price;const r=await pool.query("SELECT * FROM trade_results WHERE symbol=$1 AND status='OPEN' AND lifecycle_status<>'CANCELLED' ORDER BY signal_time",[symbol]);const out=[];for(const t of r.rows){const entry=+t.entry,sl=+t.stop_loss,tp1=+t.tp1,tp2=+t.tp2;let active=!!t.entry_touched;if(!active){active=t.side==="BUY"?px<=entry:px>=entry;if(active){await pool.query("UPDATE trade_results SET entry_touched=TRUE,lifecycle_status='ACTIVE',lifecycle_reason='ENTRY_TOUCHED',lifecycle_updated_at=NOW() WHERE hourly_id=$1",[t.hourly_id]);out.push({...t,status:"ENTRY_TOUCHED",lifecycle_status:"ACTIVE",lifecycle_reason:"ENTRY_TOUCHED"});}}if(!active)continue;let status=null,exit=null;if(t.side==="BUY"){if(px<=sl){status=t.tp1_touched?"TP1":"SL";exit=t.tp1_touched?tp1:sl}else if(px>=tp2){status="TP2";exit=tp2}else if(!t.tp1_touched&&px>=tp1){await pool.query("UPDATE trade_results SET tp1_touched=TRUE WHERE hourly_id=$1",[t.hourly_id]);out.push({...t,status:"TP1_REACHED",tp1_touched:true});continue}}else{if(px>=sl){status=t.tp1_touched?"TP1":"SL";exit=t.tp1_touched?tp1:sl}else if(px<=tp2){status="TP2";exit=tp2}else if(!t.tp1_touched&&px<=tp1){await pool.query("UPDATE trade_results SET tp1_touched=TRUE WHERE hourly_id=$1",[t.hourly_id]);out.push({...t,status:"TP1_REACHED",tp1_touched:true});continue}}if(status){const pnl=t.side==="BUY"?exit-entry:entry-exit;await pool.query("UPDATE trade_results SET status=$2,lifecycle_status=$2,lifecycle_reason=$2,lifecycle_updated_at=NOW(),exit_price=$3,pnl_points=$4,closed_at=NOW() WHERE hourly_id=$1 AND status='OPEN'",[t.hourly_id,status,exit,pnl]);out.push({...t,status,exit_price:exit,pnl_points:pnl})}}return out}
export async function getTradeStats(symbol){if(!pool)return null;const r=await pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='OPEN' AND entry_touched=FALSE AND lifecycle_status<>'CANCELLED')::int pending,COUNT(*) FILTER(WHERE status='OPEN' AND entry_touched=TRUE)::int active,COUNT(*) FILTER(WHERE lifecycle_status='CANCELLED')::int cancelled,COUNT(*) FILTER(WHERE status IN ('TP1','TP2'))::int wins,COUNT(*) FILTER(WHERE status='SL')::int losses,COUNT(*) FILTER(WHERE status='TP1')::int tp1,COUNT(*) FILTER(WHERE status='TP2')::int tp2,COALESCE(SUM(pnl_points) FILTER(WHERE status IN ('TP1','TP2','SL')),0)::float pnl_points FROM trade_results WHERE symbol=$1",[symbol]);const s=r.rows[0],closed=s.wins+s.losses;return {...s,open:s.pending+s.active,closed,winrate:closed?+(s.wins*100/closed).toFixed(2):0}}
export async function touchHeartbeat(service="MT5"){if(!pool)return false;await pool.query("INSERT INTO service_heartbeat(service,last_seen_at) VALUES($1,NOW()) ON CONFLICT(service) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at",[service]);return true}
export async function getHeartbeat(service="MT5"){if(!pool)return null;const r=await pool.query("SELECT last_seen_at FROM service_heartbeat WHERE service=$1",[service]);return r.rows[0]?.last_seen_at||null}
export async function saveM5Candle(symbol,candle){if(!pool)return false;await pool.query("INSERT INTO m5_candles(symbol,candle_time,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(symbol,candle_time) DO UPDATE SET payload=EXCLUDED.payload,received_at=NOW()",[symbol,new Date(candle.time).toISOString(),JSON.stringify(candle)]);return true}
export async function getM5Block(symbol,blockStart){if(!pool)return[];const start=new Date(blockStart),end=new Date(start.getTime()+60*60*1000);const r=await pool.query("SELECT payload FROM m5_candles WHERE symbol=$1 AND candle_time >= $2 AND candle_time < $3 ORDER BY candle_time ASC",[symbol,start.toISOString(),end.toISOString()]);return r.rows.map(x=>x.payload)}
export async function getCurrentM5Count(symbol,now=new Date()){if(!pool)return null;const start=new Date(now);start.setUTCMinutes(0,0,0);const r=await pool.query("SELECT COUNT(*)::int AS n FROM m5_candles WHERE symbol=$1 AND candle_time >= $2 AND candle_time < $3",[symbol,start.toISOString(),new Date(start.getTime()+3600000).toISOString()]);return r.rows[0]?.n??0}

export async function getTradeJournal(symbol,period="daily",date=new Date().toISOString().slice(0,10)){if(!pool)return null;const unit=period==="monthly"?"month":"day";const r=await pool.query(`SELECT hourly_id,symbol,side,entry,stop_loss,tp1,tp2,confidence,signal_time,status,entry_touched,tp1_touched,lifecycle_status,lifecycle_reason,lifecycle_updated_at,exit_price,pnl_points,closed_at FROM trade_results WHERE symbol=$1 AND signal_time >= date_trunc('${unit}',$2::timestamptz) AND signal_time < date_trunc('${unit}',$2::timestamptz)+INTERVAL '1 ${unit}' ORDER BY signal_time DESC, created_at DESC`,[symbol,date+"T00:00:00Z"]);const rows=r.rows;const closed=rows.filter(t=>["TP1","TP2","SL"].includes(t.status)),wins=closed.filter(t=>t.status==="TP1"||t.status==="TP2").length,losses=closed.filter(t=>t.status==="SL").length;return{period,date,total:rows.length,open:rows.filter(t=>t.status==="OPEN").length,tp1:rows.filter(t=>t.status==="TP1").length,tp2:rows.filter(t=>t.status==="TP2").length,sl:losses,closed:closed.length,wins,losses,winrate:closed.length?+(wins*100/closed.length).toFixed(2):0,pnlPoints:+rows.reduce((a,t)=>a+(+t.pnl_points||0),0).toFixed(2),trades:rows}}

export async function getLatestOpenTrade(symbol){if(!pool)return null;const r=await pool.query("SELECT hourly_id,symbol,side,entry,stop_loss,tp1,tp2,confidence,signal_time,status FROM trade_results WHERE symbol=$1 AND status='OPEN' AND lifecycle_status<>'CANCELLED' ORDER BY signal_time DESC LIMIT 1",[symbol]);return r.rows[0]||null}

export async function hasTradeSignal(hourlyId){if(!pool)return false;const r=await pool.query("SELECT 1 FROM trade_results WHERE hourly_id=$1 LIMIT 1",[hourlyId]);return r.rowCount>0}
export async function normalizeLegacyHourlySignals(symbol){if(!pool)return 0;const r=await pool.query("SELECT hourly_id,signal_time FROM trade_results WHERE symbol=$1 ORDER BY signal_time",[symbol]);let changed=0;for(const t of r.rows){const slot=new Date(t.signal_time);if(slot.getUTCMinutes()===0&&slot.getUTCSeconds()===0)continue;slot.setUTCMinutes(0,0,0);const newId=symbol+":"+slot.toISOString();const exists=await pool.query("SELECT 1 FROM trade_results WHERE hourly_id=$1",[newId]);if(exists.rowCount){await pool.query("DELETE FROM trade_results WHERE hourly_id=$1",[t.hourly_id])}else{await pool.query("UPDATE trade_results SET hourly_id=$2,signal_time=$3 WHERE hourly_id=$1",[t.hourly_id,newId,slot.toISOString()])}changed++}return changed}

export async function getLatestTrade(symbol){if(!pool)return null;const r=await pool.query("SELECT hourly_id,symbol,side,entry,stop_loss,tp1,tp2,confidence,signal_time,status,exit_price,pnl_points,closed_at FROM trade_results WHERE symbol=$1 ORDER BY signal_time DESC,created_at DESC LIMIT 1",[symbol]);return r.rows[0]||null}

export async function saveTradeLearningContext(x){
 if(!pool)return false;
 await pool.query("INSERT INTO trade_learning(hourly_id,symbol,regime,strategy,context) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(hourly_id) DO UPDATE SET regime=EXCLUDED.regime,strategy=EXCLUDED.strategy,context=EXCLUDED.context",
 [x.hourlyId,x.symbol,x.regime||"UNKNOWN",x.strategy||"UNKNOWN",JSON.stringify(x.context||{})]);return true;
}
export async function saveTradeReview(hourlyId,outcome,pnlPoints,review){
 if(!pool)return false;
 await pool.query("UPDATE trade_learning SET outcome=$2,pnl_points=$3,review=$4::jsonb,reviewed_at=NOW() WHERE hourly_id=$1",
 [hourlyId,outcome,Number(pnlPoints)||0,JSON.stringify(review||{})]);return true;
}
export async function getLearningMemory(symbol,limit=40){
 if(!pool)return[];
 const r=await pool.query("SELECT hourly_id,regime,strategy,context,outcome,pnl_points,review,created_at,reviewed_at FROM trade_learning WHERE symbol=$1 ORDER BY created_at DESC LIMIT $2",[symbol,Math.max(1,Math.min(100,+limit||40))]);
 return r.rows;
}

// Rolling adaptive memory: use finalized history from today first, then automatically
// extend backwards up to 7 days when the current-day sample is still thin.
// Newer outcomes carry more weight, and matching regimes receive an extra boost.
export async function getRollingLearningMemory(symbol,{minSamples=20,maxDays=7,limit=200,currentRegime=null}={}){
 if(!pool)return[];
 const days=Math.max(1,Math.min(7,+maxDays||7));
 const min=Math.max(1,+minSamples||20);
 const cap=Math.max(min,Math.min(500,+limit||200));
 const r=await pool.query(`
  SELECT hourly_id,regime,strategy,context,outcome,pnl_points,review,created_at,reviewed_at,
         GREATEST(0,EXTRACT(EPOCH FROM (NOW()-COALESCE(reviewed_at,created_at)))/86400.0) AS age_days
  FROM trade_learning
  WHERE symbol=$1
    AND outcome IN ('TP1_REACHED','TP1','TP2','SL')
    AND COALESCE(reviewed_at,created_at) >= NOW()-($2::text||' days')::interval
  ORDER BY COALESCE(reviewed_at,created_at) DESC
  LIMIT $3`,[symbol,String(days),cap]);
 const rows=r.rows.map(x=>{
  const age=Math.max(0,Number(x.age_days)||0);
  // Half-life ~= 2 days: today dominates, but one-week history can bootstrap learning.
  const timeWeight=Math.pow(0.5,age/2);
  const regimeMatch=currentRegime&&String(currentRegime)!=="UNKNOWN"&&String(x.regime)===String(currentRegime);
  const regimeWeight=regimeMatch?1.20:1.00;
  return {...x,ageDays:+age.toFixed(3),timeWeight:+timeWeight.toFixed(4),regimeWeight,learningWeight:+(timeWeight*regimeWeight).toFixed(4)};
 });
 // Keep all available current/recent samples up to the cap. minSamples is metadata for
 // checkpoint confidence; it must never fabricate or duplicate historical trades.
 rows.minSamplesTarget=min;
 return rows;
}

export async function getTradesBetween(symbol,start,end){
 if(!pool)return[];
 const r=await pool.query("SELECT hourly_id,symbol,side,entry,stop_loss,tp1,tp2,confidence,signal_time,status,entry_touched,tp1_touched,exit_price,pnl_points,closed_at FROM trade_results WHERE symbol=$1 AND signal_time >= $2::timestamptz AND signal_time < $3::timestamptz ORDER BY signal_time ASC",[symbol,start,end]);
 return r.rows;
}
export async function getLearningSummary(symbol){
 if(!pool)return[];
 const r=await pool.query(`SELECT COALESCE(regime,'UNKNOWN') regime,COALESCE(strategy,'UNKNOWN') strategy,COUNT(*)::int samples,COUNT(*) FILTER(WHERE outcome IN ('TP1_REACHED','TP2'))::int wins,COUNT(*) FILTER(WHERE outcome='SL')::int losses,COALESCE(SUM(pnl_points),0)::float pnl_points FROM trade_learning WHERE symbol=$1 AND outcome IS NOT NULL GROUP BY 1,2 ORDER BY samples DESC,pnl_points DESC`,[symbol]);
 return r.rows.map(x=>({...x,winrate:(x.wins+x.losses)?+(x.wins*100/(x.wins+x.losses)).toFixed(2):0}));
}

export async function evaluatePendingSetups(symbol,price){
 if(!pool||!Number.isFinite(+price))return[];
 const px=+price;
 const r=await pool.query("SELECT * FROM trade_results WHERE symbol=$1 AND status='OPEN' AND entry_touched=FALSE AND lifecycle_status<>'CANCELLED' ORDER BY signal_time",[symbol]);
 const events=[];
 for(const t of r.rows){
  const entry=+t.entry,sl=+t.stop_loss,tp1=+t.tp1,tp2=+t.tp2;
  let cancelReason=null;
  // Passing TP1 before entry requires re-evaluation; do not auto-cancel.
  const targetPassed=(t.side==='BUY' && px>=tp1)||(t.side==='SELL' && px<=tp1);
  if(targetPassed){
   await pool.query("UPDATE trade_results SET lifecycle_status='PENDING',lifecycle_reason='TARGET_PASSED_REVIEW_REQUIRED',lifecycle_updated_at=NOW() WHERE hourly_id=$1 AND entry_touched=FALSE AND status='OPEN'",[t.hourly_id]);
  }
  // If price crosses structural invalidation before entry, cancel the untouched setup.
  if(t.side==='BUY' && px<=sl)cancelReason='STRUCTURE_INVALIDATED_BEFORE_ENTRY';
  if(t.side==='SELL' && px>=sl)cancelReason='STRUCTURE_INVALIDATED_BEFORE_ENTRY';
  if(cancelReason){
   await pool.query("UPDATE trade_results SET status='CANCELLED',lifecycle_status='CANCELLED',lifecycle_reason=$2,lifecycle_updated_at=NOW(),closed_at=NOW(),pnl_points=0 WHERE hourly_id=$1 AND entry_touched=FALSE AND status='OPEN'",[t.hourly_id,cancelReason]);
   events.push({...t,status:'CANCELLED',lifecycle_status:'CANCELLED',lifecycle_reason:cancelReason});
  }else if(!targetPassed){
   await pool.query("UPDATE trade_results SET lifecycle_status='PENDING',lifecycle_reason='STILL_REACHABLE',lifecycle_updated_at=NOW() WHERE hourly_id=$1 AND entry_touched=FALSE",[t.hourly_id]);
  }
 }
 return events;
}
