import { gatewayMetrics } from "./observability.js";

export class ReconciliationWorker {
  /** @param {{store:import("./contracts.js").WorkerStore,providers?:Map<string,{reconcile?:(input:{providerRequestId?:string|null,requestId:string,reservationId:string,route?:import("./contracts.js").ProviderRoute|null})=>Promise<import("./contracts.js").ReconciliationResult|undefined>}>,maxAttempts?:number,batchSize?:number,staleAfterMs?:number}} options */
  constructor({ store, providers, maxAttempts = 8, batchSize = 20, staleAfterMs = 120_000 } = {}) {
    if (!store?.claimReconciliationJobs || !store?.retryReconciliation) throw new Error("ReconciliationWorker requires a durable store.");
    this.store = store;
    this.providers = providers instanceof Map ? providers : new Map(Object.entries(providers ?? {}));
    this.maxAttempts = maxAttempts;
    this.batchSize = batchSize;
    this.staleAfterMs = staleAfterMs;
  }

  async runOnce() {
    const jobs = await this.store.claimReconciliationJobs({ limit: this.batchSize, staleAfterMs: this.staleAfterMs });
    const results = [];
    for (const job of jobs) {
      try {
        if (job.reservation_state === "active") {
          await this.store.releaseReservation({ reservationId: job.reservation_id, reason: "gateway_crashed_before_provider_start" });
          results.push({ reservation_id: job.reservation_id, outcome: "released_unstarted" });
          continue;
        }
        const provider = this.providers.get(job.provider);
        const outcome = await provider?.reconcile?.({ providerRequestId: job.provider_request_id, requestId: job.request_id, reservationId: job.reservation_id, route:job.provider_route });
        if (outcome?.kind === "usage") {
          await this.store.settle({ reservationId: job.reservation_id, usage: { ...outcome.usage, route:outcome.usage.route??job.provider_route, pricing_version:job.provider_route?.pricing_version, config_version:job.provider_route?.config_version } });
          results.push({ reservation_id: job.reservation_id, outcome: "settled" });
          continue;
        }
        if (outcome?.kind === "not_executed") {
          await this.store.releaseReservation({ reservationId: job.reservation_id, reason: "provider_confirmed_not_executed" });
          results.push({ reservation_id: job.reservation_id, outcome: "released_confirmed" });
          continue;
        }
        const retry = await this.store.retryReconciliation({ reservationId: job.reservation_id, error: outcome?.message ?? "Provider cannot confirm the request outcome.", maxAttempts: this.maxAttempts });
        results.push({ reservation_id: job.reservation_id, outcome: retry.deadLetter ? "dead_letter" : "retry" });
      } catch (error) {
        const retry = await this.store.retryReconciliation({ reservationId: job.reservation_id, error, maxAttempts: this.maxAttempts });
        results.push({ reservation_id: job.reservation_id, outcome: retry.deadLetter ? "dead_letter" : "retry" });
      }
    }
    const backlog=await this.store.getReconciliationBacklog?.();
    if(backlog){
      gatewayMetrics.gauge("aegis_reconciliation_backlog",backlog.reconciliation_count);
      gatewayMetrics.gauge("aegis_reconciliation_oldest_age_seconds",backlog.oldest_age_seconds);
      gatewayMetrics.gauge("aegis_outbox_backlog",backlog.outbox_count);
    }
    return { claimed: jobs.length, results };
  }
}
