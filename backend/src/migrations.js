import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(pool, { directory = defaultDirectory } = {}) {
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("CREATE TABLE IF NOT EXISTS aegis_schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    for (const file of files) {
      const sql = await readFile(join(directory, file), "utf8");
      const version = file.slice(0, file.indexOf("_"));
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existingResult = await client.query("SELECT checksum FROM aegis_schema_migrations WHERE version = $1", [version]);
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration ${version} was changed; add a new migration instead.`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO aegis_schema_migrations (version, checksum) VALUES ($1, $2)", [version, checksum]);
        await client.query("COMMIT");
        applied.push(version);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
    return { applied, current: files.length };
  } finally { client.release(); }
}
