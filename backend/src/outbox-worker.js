import { gatewayMetrics } from "./observability.js";

export class OutboxWorker {
  /** @param {{store:import("./contracts.js").WorkerStore,publish:(payload:Record<string,unknown>,meta:{idempotencyKey:string,eventId:number})=>Promise<unknown>,batchSize?:number,maxAttempts?:number,staleAfterMs?:number}} options */
  constructor({ store, publish, batchSize = 50, maxAttempts = 12, staleAfterMs = 60_000 } = {}) {
    if(!store?.claimOutboxEvents||!store?.markOutboxPublished||!store?.retryOutbox)throw new Error("OutboxWorker requires a durable outbox store.");
    if(typeof publish!=="function")throw new Error("OutboxWorker requires an idempotent event publisher.");
    this.store=store;this.publish=publish;this.batchSize=batchSize;this.maxAttempts=maxAttempts;this.staleAfterMs=staleAfterMs;
  }
  async runOnce(){
    const events=await this.store.claimOutboxEvents({limit:this.batchSize,staleAfterMs:this.staleAfterMs});
    const results=[];
    for(const event of events){
      try{
        await this.publish(event.payload,{idempotencyKey:event.event_key,eventId:event.outbox_id});
        await this.store.markOutboxPublished(event.outbox_id);
        results.push({event_id:event.outbox_id,outcome:"published"});
      }catch(error){
        const retry=await this.store.retryOutbox({outboxId:event.outbox_id,error,maxAttempts:this.maxAttempts});
        results.push({event_id:event.outbox_id,outcome:retry.deadLetter?"dead_letter":"retry"});
      }
    }
    const backlog=await this.store.getReconciliationBacklog?.();
    if(backlog)gatewayMetrics.gauge("aegis_outbox_backlog",backlog.outbox_count);
    return {claimed:events.length,results};
  }
}
