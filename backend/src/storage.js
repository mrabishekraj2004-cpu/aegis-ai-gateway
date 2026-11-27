import { MemoryLedger } from "./ledger.js";
import { PostgresLedger } from "./postgres-ledger.js";
import { databaseConfigFromEnv } from "./database-config.js";

export async function createStorageFromEnv(env = process.env) {
  const mode = env.AEGIS_STORAGE || "postgres";
  if (mode === "memory") return new MemoryLedger();
  if (mode !== "postgres") throw new Error("AEGIS_STORAGE must be 'postgres' or explicitly 'memory'.");
  const databaseConfig = databaseConfigFromEnv(env);
  if (!databaseConfig) throw new Error("PostgreSQL storage selected, but all AEGIS_DATABASE_* settings are required.");
  let Pool;
  try { ({ Pool } = await import("pg")); }
  catch { throw new Error("PostgreSQL storage selected, but the 'pg' package is not installed. Run npm install in backend/."); }
  const pool = new Pool({ ...databaseConfig, max: 10, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end().catch(() => {});
    throw new Error("PostgreSQL storage selected, but the database connection failed. Check database settings and database availability.");
  }
  return new PostgresLedger({ pool });
}
