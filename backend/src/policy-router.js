import { createHash } from "node:crypto";
import { createDefaultPricing } from "./pricing.js";
import { ProviderError } from "./providers.js";

const defaultConfig = {
  version: "builtin-1",
  aliases: {
    "demo-model": [{ provider: "mock", model: "mock-chat-v1", region: "global", priority: 1, weight: 100, pricing_version: "mock-v1", max_cost_uusd: 13_000_000, max_latency_ms: 10_000 }]
  },
  tenants: {}
};

function deterministicBucket(requestId, alias) {
  const hex = createHash("sha256").update(`${requestId}:${alias}`).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffff_ffff;
}

function percentile95(values){
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]:null;
}

export class PolicyRouter {
  constructor({ providers, config = defaultConfig, pricing = createDefaultPricing(), store, maxConcurrency = Number(process.env.AEGIS_PROVIDER_MAX_CONCURRENCY||100), maxQueueDepth = Number(process.env.AEGIS_PROVIDER_MAX_QUEUE_DEPTH||32), queueTimeoutMs = Number(process.env.AEGIS_PROVIDER_QUEUE_TIMEOUT_MS||3_000), circuitThreshold = 5, circuitResetMs = 30_000 } = {}) {
    this.providers = providers instanceof Map ? providers : new Map(Object.entries(providers ?? {}));
    this.config = config;
    this.pricing = pricing;
    this.store = store;
    this.maxConcurrency=maxConcurrency;this.maxQueueDepth=maxQueueDepth;this.queueTimeoutMs=queueTimeoutMs;this.circuitThreshold=circuitThreshold;this.circuitResetMs=circuitResetMs;
    this.stats=new Map([...this.providers.keys()].map(name=>[name,{active:0,failures:0,openedUntil:0,requests:0,lastErrorAt:null,latencies:[],queued:0}]));
    this.waiters=new Map([...this.providers.keys()].map(name=>[name,[]]));
    this.alternatives=new WeakMap();
  }

  #acquire(name,signal){
    const state=this.stats.get(name);
    if(!state) return Promise.reject(new ProviderError("Provider is not configured.",{provider:name,outcomeUnknown:false,retryable:false,code:"provider_not_configured"}));
    if(state.openedUntil>Date.now())return Promise.reject(new ProviderError("Provider circuit is open.",{provider:name,outcomeUnknown:false,retryable:true,code:"provider_circuit_open",retryAfter:Math.max(1,Math.ceil((state.openedUntil-Date.now())/1000))}));
    if(signal?.aborted)return Promise.reject(new ProviderError("Client disconnected before provider admission.",{provider:name,outcomeUnknown:false,retryable:false,code:"client_cancelled"}));
    if(state.active<this.maxConcurrency){state.active++;state.requests++;return Promise.resolve();}
    const queue=this.waiters.get(name)??[];
    if(queue.length>=this.maxQueueDepth)return Promise.reject(new ProviderError("Provider queue is full.",{provider:name,outcomeUnknown:false,retryable:true,code:"provider_overloaded",retryAfter:Math.max(1,Math.ceil(this.queueTimeoutMs/1000))}));
    return new Promise((resolve,reject)=>{
      const waiter={resolve,reject,signal,timer:null,onAbort:null};
      const remove=()=>{const index=queue.indexOf(waiter);if(index>=0)queue.splice(index,1);state.queued=queue.length;clearTimeout(waiter.timer);signal?.removeEventListener("abort",waiter.onAbort);};
      waiter.onAbort=()=>{remove();reject(new ProviderError("Client disconnected while waiting for provider capacity.",{provider:name,outcomeUnknown:false,retryable:false,code:"client_cancelled"}));};
      waiter.timer=setTimeout(()=>{remove();reject(new ProviderError("Provider queue wait exceeded its deadline.",{provider:name,outcomeUnknown:false,retryable:true,code:"provider_overloaded",retryAfter:Math.max(1,Math.ceil(this.queueTimeoutMs/1000))}));},this.queueTimeoutMs);
      signal?.addEventListener("abort",waiter.onAbort,{once:true});
      queue.push(waiter);state.queued=queue.length;
    });
  }

  #release(name){
    const state=this.stats.get(name);if(!state)return;
    state.active=Math.max(0,state.active-1);
    const queue=this.waiters.get(name)??[];
    while(state.active<this.maxConcurrency&&queue.length){
      const waiter=queue.shift();clearTimeout(waiter.timer);waiter.signal?.removeEventListener("abort",waiter.onAbort);state.queued=queue.length;
      if(waiter.signal?.aborted){waiter.reject(new ProviderError("Client disconnected while waiting for provider capacity.",{provider:name,outcomeUnknown:false,retryable:false,code:"client_cancelled"}));continue;}
      if(state.openedUntil>Date.now()){waiter.reject(new ProviderError("Provider circuit opened while the request was queued.",{provider:name,outcomeUnknown:false,retryable:true,code:"provider_circuit_open",retryAfter:Math.max(1,Math.ceil((state.openedUntil-Date.now())/1000))}));continue;}
      state.active++;state.requests++;waiter.resolve();
    }
  }

  async #run(name,work,{countFailure=()=>true,signal}={}){
    const state=this.stats.get(name);
    if(!state)throw new ProviderError("Provider is not configured.",{provider:name,outcomeUnknown:false,retryable:false,code:"provider_not_configured"});
    await this.#acquire(name,signal);
    const started=Date.now();
    try{const result=await work();state.failures=0;state.openedUntil=0;return result;}
    catch(error){if(countFailure()){state.failures++;state.lastErrorAt=Date.now();if(state.failures>=this.circuitThreshold)state.openedUntil=Date.now()+this.circuitResetMs;}throw error;}
    finally{
      state.latencies.push(Date.now()-started);
      if(state.latencies.length>100)state.latencies.shift();
      this.#release(name);
    }
  }

  async resolveRoute(alias, { tenantId, requestId } = {}) {
    const config = await this.store?.getActiveRoutingConfig?.(tenantId) ?? this.config;
    const tenantPolicy = config.tenants?.[tenantId] ?? {};
    const allowed = new Set(tenantPolicy.model_allowlist ?? Object.keys(config.aliases ?? {}));
    if (!allowed.has(alias)) return null;
    const candidates = tenantPolicy.routes?.[alias] ?? config.aliases?.[alias];
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const configured=candidates.filter(route=>this.providers.has(route.provider));
    const eligible = configured.filter(route => {
      const status=this.stats.get(route.provider);
      if(!status||status.openedUntil>Date.now())return false;
      const sorted=[...status.latencies].sort((a,b)=>a-b);
      const p95=sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]:0;
      return route.max_latency_ms==null||p95===0||p95<=route.max_latency_ms;
    });
    const pool=eligible.length?eligible:configured;
    const sorted = pool
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    if (!sorted.length) return null;
    const priority = sorted[0].priority ?? 100;
    const tier = sorted.filter(route => (route.priority ?? 100) === priority);
    const total = tier.reduce((sum, route) => sum + Math.max(0, Number(route.weight ?? 1)), 0);
    const bucket = deterministicBucket(requestId ?? "route-preview", alias) * total;
    let cursor = 0;
    const chosen = tier.find(route => { cursor += Math.max(0, Number(route.weight ?? 1)); return bucket <= cursor; }) ?? tier.at(-1);
    const selected={
      provider: chosen.provider, model: chosen.model, alias, region: chosen.region ?? "global",
      config_version: config.version, pricing_version: chosen.pricing_version ?? null,
      decision: { reason: tenantPolicy.routes?.[alias] ? "tenant_policy" : eligible.length?"priority_weighted":"best_available_fallback", priority, weight: chosen.weight ?? 1, candidates: tier.length, latency_target_ms:chosen.max_latency_ms??null, provider_p95_latency_ms:percentile95(this.stats.get(chosen.provider)?.latencies??[]) },
      max_latency_ms: chosen.max_latency_ms ?? null, max_cost_uusd: chosen.max_cost_uusd ?? null
    };
    this.alternatives.set(selected,tenantPolicy.failover_enabled===false||chosen.failover_enabled===false?[]:sorted.filter(route=>route!==chosen).map(route=>({
      provider:route.provider,model:route.model,alias,region:route.region??"global",config_version:config.version,pricing_version:route.pricing_version??null,
      decision:{reason:"provider_failover",priority:route.priority??100,weight:route.weight??1,candidates:sorted.length},
      max_latency_ms:route.max_latency_ms??null,max_cost_uusd:route.max_cost_uusd??null
    })));
    return selected;
  }

  async quote({ route, prompt = "", maxTokens = 0, scenario }) {
    const adapter = this.providers.get(route.provider);
    if (adapter?.quote) return adapter.quote({ route, prompt, maxTokens, scenario });
    const pricing = await this.store?.findPricing?.({ provider: route.provider, model: route.model, region: route.region })
      ?? this.pricing.find({ provider: route.provider, model: route.model, region: route.region });
    if (!pricing) throw new Error(`No effective pricing is published for ${route.provider}/${route.model}.`);
    route.pricing_version = pricing.version;
    route.pricing = { input_usd_per_million: Number(pricing.input_usd_per_million), output_usd_per_million: Number(pricing.output_usd_per_million) };
    const inputTokens = Math.max(1, Math.ceil(prompt.length / 4));
    return this.pricing.calculate({ pricing, inputTokens, outputTokens: maxTokens });
  }

  async invoke(route, request) {
    const candidates=[route,...(request.failoverRoutes??[])];
    let lastError;
    for(let attempt=0;attempt<candidates.length;attempt++){
      const candidate=candidates[attempt];
      const adapter=this.providers.get(candidate.provider);
      if(!adapter){lastError=new ProviderError("Provider is not configured.",{provider:candidate.provider,outcomeUnknown:false,retryable:true,code:"provider_not_configured"});continue;}
      try{
        let invoked=false;
        const result=await this.#run(candidate.provider,async()=>{
          try{
            const recorded=await request.beforeProviderStart?.(candidate,attempt+1);
            if(recorded===false)throw new Error("Reservation is no longer active.");
          }catch{throw new ProviderError("The gateway could not record provider start before invocation.",{provider:candidate.provider,outcomeUnknown:false,retryable:false,code:"provider_start_record_failed"});}
          invoked=true;
          return adapter.invoke({...request,failoverRoutes:undefined,beforeProviderStart:undefined,route:candidate});
        },{countFailure:()=>invoked,signal:request.signal});
        return {...result,selectedRoute:candidate};
      }catch(error){
        lastError=error;
        if(!(error instanceof ProviderError)||!error.retryable||error.outcomeUnknown||attempt+1>=candidates.length)throw error;
      }
    }
    throw lastError??new Error("No provider candidate was eligible.");
  }

  async *stream(route, request) {
    const candidates=[route,...(request.failoverRoutes??[])];
    let lastError;
    for(let attempt=0;attempt<candidates.length;attempt++){
      const candidate=candidates[attempt];
      const adapter=this.providers.get(candidate.provider);
      if(!adapter?.stream){lastError=new ProviderError("Provider does not support streaming.",{provider:candidate.provider,outcomeUnknown:false,retryable:true,code:"streaming_unsupported"});continue;}
      const state=this.stats.get(candidate.provider);
      let invoked=false,acquired=false;
      let emitted=false;
      try{
        await this.#acquire(candidate.provider,request.signal);
        acquired=true;
        const recorded=await request.beforeProviderStart?.(candidate,attempt+1);
        if(recorded===false)throw new ProviderError("The gateway could not record provider start before invocation.",{provider:candidate.provider,outcomeUnknown:false,retryable:false,code:"provider_start_record_failed"});
        invoked=true;
        for await(const event of adapter.stream({...request,failoverRoutes:undefined,beforeProviderStart:undefined,route:candidate})){
          if(event.type==="delta")emitted=true;
          yield {...event,selectedRoute:candidate};
        }
        state.failures=0;state.openedUntil=0;return;
      }catch(error){
        if(invoked){state.failures++;state.lastErrorAt=Date.now();if(state.failures>=this.circuitThreshold)state.openedUntil=Date.now()+this.circuitResetMs;}
        lastError=error;
        if(emitted||!(error instanceof ProviderError)||!error.retryable||error.outcomeUnknown||attempt+1>=candidates.length)throw error;
      }finally{if(acquired)this.#release(candidate.provider);}
    }
    throw lastError??new Error("No streaming provider candidate was eligible.");
  }

  async getFailovers(route,{prompt="",maxTokens=0,scenario}={}){
    const routes=this.alternatives.get(route)??[];
    const primaryQuote=await this.quote({route,prompt,maxTokens,scenario});
    const eligible=[];
    for(const candidate of routes){
      try{const quote=await this.quote({route:candidate,prompt,maxTokens,scenario});if(quote<=primaryQuote&&(candidate.max_cost_uusd==null||quote<=candidate.max_cost_uusd))eligible.push(candidate);}catch{ /* An unpriceable failover route is ineligible. */ }
    }
    return eligible;
  }

  getProviderHealth(){return [...this.stats].map(([name,state])=>({name,status:state.openedUntil>Date.now()?"circuit_open":state.active>=this.maxConcurrency?"saturated":"available",active:state.active,queued:state.queued,queue_limit:this.maxQueueDepth,requests:state.requests,failures:state.failures,p95_latency_ms:percentile95(state.latencies),last_error_at:state.lastErrorAt?new Date(state.lastErrorAt).toISOString():null}));}
}

export { defaultConfig as defaultRoutingConfig };
