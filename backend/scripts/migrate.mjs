import { migrate } from "../src/migrations.js";
import { databaseConfigFromEnv } from "../src/database-config.js";

const databaseConfig = databaseConfigFromEnv();
if (!databaseConfig) {
  console.error("Migration stopped: set all AEGIS_DATABASE_* settings for the target PostgreSQL database.");
  process.exitCode = 1;
} else {
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ ...databaseConfig, connectionTimeoutMillis: 3000 });
    try {
      const result = await migrate(pool);
      console.log(`Migrations complete. Applied: ${result.applied.length}; versioned: ${result.current}.`);
    } finally { await pool.end(); }
  } catch {
    console.error("Migration failed. Check that the 'pg' package is installed and the database settings point to a reachable PostgreSQL database.");
    process.exitCode = 1;
  }
}
