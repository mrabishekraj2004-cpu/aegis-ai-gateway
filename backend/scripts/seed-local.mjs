import { createStorageFromEnv } from "../src/storage.js";

if (process.env.AEGIS_MODE !== "local" || (process.env.AEGIS_STORAGE || "postgres") !== "postgres") {
  console.error("Local seed stopped: explicitly set AEGIS_MODE=local and AEGIS_STORAGE=postgres.");
  process.exitCode = 1;
} else {
  let store;
  try {
    store = await createStorageFromEnv();
    await store.seedTenant({ id: "tenant_demo_aster", name: "Aster Labs", limit_uusd: 20_000_000, seeded_settled_uusd: 7_420_000 });
    await store.seedTenant({ id: "tenant_demo_juniper", name: "Juniper Health", limit_uusd: 10_000_000, seeded_settled_uusd: 0 });
    await store.seedTenant({ id: "tenant_demo_budget", name: "Budget Demo", limit_uusd: 340_000, seeded_settled_uusd: 0 });
    console.log("Synthetic local tenants are ready, including the one-request $0.34 budget demo.");
  } catch {
    console.error("Local seeding failed. Check the 'pg' package, DATABASE_URL, applied migrations, and database availability.");
    process.exitCode = 1;
  } finally {
    if (store?.pool) await store.pool.end();
  }
}
