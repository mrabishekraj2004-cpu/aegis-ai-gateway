import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createStorageFromEnv } from "../src/storage.js";
import { MemoryLedger } from "../src/ledger.js";
import { localDemoCredentialsFromEnv } from "../src/auth.js";
import { databaseConfigFromEnv } from "../src/database-config.js";

test("memory storage is available only when explicitly selected", async () => {
  const store = await createStorageFromEnv({ AEGIS_STORAGE: "memory" });
  assert.ok(store instanceof MemoryLedger);
});

test("PostgreSQL selection without structured settings fails instead of falling back", async () => {
  await assert.rejects(
    createStorageFromEnv({ AEGIS_STORAGE: "postgres" }),
    /PostgreSQL storage selected, but all AEGIS_DATABASE_\* settings are required/
  );
});

test("Neon DATABASE_URL is accepted as the connection string without logging it", () => {
  const connectionString = ["postgresql:", "//localhost/aegis?sslmode=require"].join("");
  const normalized = ["postgresql:", "//localhost/aegis?sslmode=verify-full"].join("");
  assert.deepEqual(databaseConfigFromEnv({ DATABASE_URL: connectionString }), {
    connectionString: normalized, ssl: { rejectUnauthorized: true }
  });
});

test("structured database settings preserve generated credentials and enable TLS", () => {
  const password = randomBytes(32).toString("base64url");
  const config = databaseConfigFromEnv({
    AEGIS_DATABASE_HOST: "postgres",
    AEGIS_DATABASE_PORT: "5432",
    AEGIS_DATABASE_NAME: "aegis",
    AEGIS_DATABASE_USER: "aegis_user",
    AEGIS_DATABASE_PASSWORD: password,
    AEGIS_DATABASE_SSL: "true"
  });
  assert.ok(config, "complete database settings should be accepted");
  assert.ok(config.password === password, "the generated password should remain a structured field");
  assert.deepEqual({host:config.host,port:config.port,database:config.database,user:config.user,ssl:config.ssl}, {
    host:"postgres",port:5432,database:"aegis",user:"aegis_user",ssl:{rejectUnauthorized:true}
  });
});

test("unknown storage modes are rejected", async () => {
  await assert.rejects(
    createStorageFromEnv({ AEGIS_STORAGE: "automatic" }),
    /AEGIS_STORAGE must be/
  );
});

test("local bearer credentials come only from explicit environment configuration", () => {
  const asterToken = randomBytes(32).toString("base64url");
  const budgetToken = randomBytes(32).toString("base64url");
  const credentials = localDemoCredentialsFromEnv({
    AEGIS_DEMO_ASTER_TOKEN: asterToken,
    AEGIS_DEMO_JUNIPER_TOKEN: "",
    AEGIS_DEMO_BUDGET_TOKEN: budgetToken
  });
  assert.equal(credentials.size, 2);
  assert.ok(credentials.get(asterToken) === "tenant_demo_aster");
  assert.ok(credentials.get(budgetToken) === "tenant_demo_budget");
});
