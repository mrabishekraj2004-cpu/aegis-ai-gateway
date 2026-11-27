// @ts-check
import { createProviderRegistry } from "./src/providers.js";
import { OutboxWorker } from "./src/outbox-worker.js";
import { ReconciliationWorker } from "./src/reconciliation-worker.js";
import { initializeTelemetry } from "./src/observability.js";
import { createStorageFromEnv } from "./src/storage.js";

const mode=process.env.AEGIS_MODE??"disabled";
const intervalMs=Number(process.env.AEGIS_WORKER_INTERVAL_MS??5_000);
if(!Number.isSafeInteger(intervalMs)||intervalMs<250)throw new Error("AEGIS_WORKER_INTERVAL_MS must be at least 250 milliseconds.");

const telemetry=await initializeTelemetry();
const storage=await createStorageFromEnv();
if(storage.storageMode!=="postgres")throw new Error("Background workers require PostgreSQL storage.");
/** @type {import("./src/contracts.js").WorkerStore} */
const store=/** @type {import("./src/contracts.js").WorkerStore} */(/** @type {unknown} */(storage));
const providers=createProviderRegistry({includeMock:mode==="local"});
if(mode==="production"&&providers.size===0){await store.pool?.end?.();await telemetry.shutdown?.();throw new Error("Production workers require at least one configured provider adapter.");}
const reconciliation=new ReconciliationWorker({store,providers,maxAttempts:Number(process.env.AEGIS_RECONCILE_MAX_ATTEMPTS??8)});
const outbox=new OutboxWorker({
  store,
  publish:(payload,{idempotencyKey})=>store.publishIntegrationEvent({payload,idempotencyKey}),
  maxAttempts:Number(process.env.AEGIS_OUTBOX_MAX_ATTEMPTS??12)
});

let stopping=false;
process.once("SIGINT",()=>{stopping=true;});
process.once("SIGTERM",()=>{stopping=true;});
const once=process.argv.includes("--once");
try{
  do{
    const [reconciled,published]=await Promise.all([reconciliation.runOnce(),outbox.runOnce()]);
    if(reconciled.claimed||published.claimed){
      /** @param {Array<{outcome:string}>} results */
      const countOutcomes=results=>{
        const counts=/** @type {Record<string,number>} */({});
        for(const result of results)counts[result.outcome]=(counts[result.outcome]??0)+1;
        return counts;
      };
      console.log(JSON.stringify({event:"gateway_workers_batch",reconciliation:{claimed:reconciled.claimed,outcomes:countOutcomes(reconciled.results)},outbox:{claimed:published.claimed,outcomes:countOutcomes(published.results)}}));
    }
    if(once||stopping)break;
    await new Promise(resolve=>setTimeout(resolve,intervalMs));
  }while(!stopping);
}finally{
  await store.pool?.end?.();
  await telemetry.shutdown?.();
}
