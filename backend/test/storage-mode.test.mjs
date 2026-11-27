import test from "node:test";
import assert from "node:assert/strict";
import { createStorageFromEnv } from "../src/storage.js";
import { MemoryLedger } from "../src/ledger.js";
import { localDemoCredentialsFromEnv } from "../src/auth.js";

test("memory storage is available only when explicitly selected", async () => {
  const store = await createStorageFromEnv({ AEGIS_STORAGE: "memory" });
  assert.ok(store instanceof MemoryLedger);
});

test("PostgreSQL selection without DATABASE_URL fails clearly instead of falling back", async () => {
  await assert.rejects(
    createStorageFromEnv({ AEGIS_STORAGE: "postgres" }),
    /PostgreSQL storage selected, but DATABASE_URL is not set/
  );
});

test("unknown storage modes are rejected", async () => {
  await assert.rejects(
    createStorageFromEnv({ AEGIS_STORAGE: "automatic" }),
    /AEGIS_STORAGE must be/
  );
});

test("local bearer credentials come only from explicit environment configuration", () => {
  const credentials = localDemoCredentialsFromEnv({
    AEGIS_DEMO_ASTER_TOKEN: "test-aster-token",
    AEGIS_DEMO_JUNIPER_TOKEN: "",
    AEGIS_DEMO_BUDGET_TOKEN: "test-budget-token"
  });
  assert.deepEqual([...credentials], [
    ["test-aster-token", "tenant_demo_aster"],
    ["test-budget-token", "tenant_demo_budget"]
  ]);
});
