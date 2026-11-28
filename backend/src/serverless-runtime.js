import { createGateway } from "./gateway.js";
import { createProviderRegistry } from "./providers.js";
import { createStorageFromEnv } from "./storage.js";
import { initializeTelemetry } from "./observability.js";
import { OutboxWorker } from "./outbox-worker.js";
import { ReconciliationWorker } from "./reconciliation-worker.js";

let storePromise;
let gatewayPromise;
let telemetryPromise;

function configuredOrigin() {
  if (process.env.AEGIS_ALLOWED_ORIGIN) return process.env.AEGIS_ALLOWED_ORIGIN;
  const host = process.env.VERCEL_URL;
  return host && /^[A-Za-z0-9.-]+$/.test(host) ? `https://${host}` : "https://invalid.aegis.local";
}

function getStore() {
  storePromise ??= createStorageFromEnv();
  return storePromise;
}

export function getGatewayRuntime() {
  gatewayPromise ??= (async () => {
    telemetryPromise ??= initializeTelemetry();
    const [store] = await Promise.all([getStore(), telemetryPromise]);
    const providers = createProviderRegistry({
      includeMock: process.env.AEGIS_INCLUDE_MOCK_PROVIDER === "true"
    });
    return createGateway({
      mode: "production",
      store,
      providers,
      keyPepper: process.env.AEGIS_KEY_PEPPER,
      allowedOrigin: configuredOrigin()
    });
  })();
  return gatewayPromise;
}

export async function runWorkerBatch() {
  const store = await getStore();
  if (store.storageMode !== "postgres") throw new Error("Background workers require PostgreSQL storage.");
  const providers = createProviderRegistry({
    includeMock: process.env.AEGIS_INCLUDE_MOCK_PROVIDER === "true"
  });
  const reconciliation = new ReconciliationWorker({
    store,
    providers,
    maxAttempts: Number(process.env.AEGIS_RECONCILE_MAX_ATTEMPTS ?? 8)
  });
  const outbox = new OutboxWorker({
    store,
    publish: (payload, { idempotencyKey }) => store.publishIntegrationEvent({ payload, idempotencyKey }),
    maxAttempts: Number(process.env.AEGIS_OUTBOX_MAX_ATTEMPTS ?? 12)
  });
  const [reconciliationResult, outboxResult] = await Promise.all([
    reconciliation.runOnce(),
    outbox.runOnce()
  ]);
  return { reconciliation: reconciliationResult, outbox: outboxResult };
}
