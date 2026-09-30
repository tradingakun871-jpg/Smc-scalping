import pg from "pg";
const {Pool}=pg;
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
export async function initDb(){if(!pool)return false;await pool.query("CREATE TABLE IF NOT EXISTS service_heartbeat (service TEXT PRIMARY KEY,last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");return true}
export async function touchHeartbeat(service="MT5"){if(!pool)return false;await pool.query("INSERT INTO service_heartbeat(service,last_seen_at) VALUES($1,NOW()) ON CONFLICT(service) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at",[service]);return true}
export async function getHeartbeat(service="MT5"){if(!pool)return null;const r=await pool.query("SELECT last_seen_at FROM service_heartbeat WHERE service=$1",[service]);return r.rows[0]?.last_seen_at||null}
