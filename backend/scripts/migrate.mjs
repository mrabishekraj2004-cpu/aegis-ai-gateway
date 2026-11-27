import { migrate } from "../src/migrations.js";

if (!process.env.DATABASE_URL) {
  console.error("Migration stopped: set DATABASE_URL to the target PostgreSQL database.");
  process.exitCode = 1;
} else {
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    try {
      const result = await migrate(pool);
      console.log(`Migrations complete. Applied: ${result.applied.length}; versioned: ${result.current}.`);
    } finally { await pool.end(); }
  } catch {
    console.error("Migration failed. Check that the 'pg' package is installed and DATABASE_URL points to a reachable PostgreSQL database.");
    process.exitCode = 1;
  }
}
