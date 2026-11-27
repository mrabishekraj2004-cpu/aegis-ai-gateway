import { createStorageFromEnv } from "../src/storage.js";
import { createProviderRegistry } from "../src/providers.js";
import { ReconciliationWorker } from "../src/reconciliation-worker.js";

const store = await createStorageFromEnv();
const providers = createProviderRegistry({ includeMock: process.env.AEGIS_MODE === "local" });
const worker = new ReconciliationWorker({ store, providers, maxAttempts: Number(process.env.AEGIS_RECONCILE_MAX_ATTEMPTS || 8) });
const intervalMs = Number(process.env.AEGIS_RECONCILE_INTERVAL_MS || 5_000);
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
try {
  while (!stopping) {
    const result = await worker.runOnce();
    if (result.claimed) console.log(JSON.stringify({ event: "reconciliation_batch", ...result }));
    if (result.claimed === 0) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
} finally {
  await store.pool?.end?.();
}
