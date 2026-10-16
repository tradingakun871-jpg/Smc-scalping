import pg from "pg";
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
let ready;
const init=()=>ready??=pool.query("CREATE TABLE IF NOT EXISTS swing_telegram_deliveries (signal_id TEXT NOT NULL,chat_id TEXT NOT NULL,sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(signal_id,chat_id))");
const wib=t=>new Date(t).toLocaleString("id-ID",{timeZone:"Asia/Jakarta",dateStyle:"medium",timeStyle:"short"});
const val=x=>x===null||x===undefined?"—":String(x);
export async function notifySwing(id,symbol,trigger,signal){
 if(!["BUY","SELL"].includes(signal.decision))return;
 const token=process.env.TELEGRAM_BOT_TOKEN;
 const chats=[...new Set([process.env.TELEGRAM_CHAT_ID,process.env.TELEGRAM_GROUP_CHAT_ID].flatMap(x=>String(x||"").split(",")).map(x=>x.trim()).filter(Boolean))];
 if(!token||!chats.length){console.warn("SWING_TELEGRAM_NOT_CONFIGURED");return;}
 await init();
 const lines=["🎯 SWING TRADE PLAN — "+symbol,"Arah: "+signal.decision,"Setup: "+val(signal.setup),"Entry: "+val(signal.entry),"SL: "+val(signal.stopLoss),"TP1: "+val(signal.tp1),"TP2: "+val(signal.tp2),"TP3: "+val(signal.tp3),"Mode: SIGNAL ONLY"];
 const message=lines.join("\n");
 const base=String(process.env.PUBLIC_APP_URL||"https://smc-scalping-ai-production.up.railway.app").replace(/\/$/,"");
 const reply_markup={inline_keyboard:[[{text:"🔎 Lihat Detail Entry",url:base+"/?view=swing&signalId="+encodeURIComponent(id)}]]};
 for(const chat of chats){
  if((await pool.query("SELECT 1 FROM swing_telegram_deliveries WHERE signal_id=$1 AND chat_id=$2",[id,chat])).rowCount)continue;
  try{
   const response=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chat,text:message,reply_markup})});
   if(!response.ok)throw Error("HTTP "+response.status);
   const json=await response.json();if(!json.ok)throw Error("Telegram response not ok");
   await pool.query("INSERT INTO swing_telegram_deliveries(signal_id,chat_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,chat]);
   console.log("SWING_TELEGRAM_SENT",JSON.stringify({id,chatSuffix:chat.slice(-4)}));
  }catch(e){console.error("SWING_TELEGRAM_ERROR",JSON.stringify({id,chatSuffix:chat.slice(-4),reason:String(e.message).slice(0,120)}));}
 }
}
