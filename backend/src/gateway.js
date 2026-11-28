import { createHash, timingSafeEqual } from "node:crypto";
import { createAuthenticator } from "./auth.js";
import { MockProvider } from "./mock-provider.js";
import { ApiKeyService } from "./api-keys.js";
import { PolicyRouter } from "./policy-router.js";
import { ProviderError } from "./providers.js";
import { handleAdminRequest } from "./admin-api.js";
import { once } from "node:events";
import { gatewayMetrics, inSpan, runInRequestContext } from "./observability.js";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const ok = (status, body, headers = {}) => ({ status, headers: { ...jsonHeaders, ...headers }, body });
const failure = (status, code, message, requestId = undefined, extra = {}) => ok(status, { error: { code, message, ...(requestId ? { request_id: requestId } : {}), ...extra } });
const header = (headers, key) => {
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === lower) return value;
  return "";
};

async function writeSse(response, event, payload, signal) {
  if (response.destroyed) return false;
  const encoded=payload === "[DONE]" ? "data: [DONE]\n\n" : `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`;
  if (!response.write(encoded)) {
    await Promise.race([
      once(response,"drain"),
      new Promise(resolve=>signal?.addEventListener("abort",resolve,{once:true}))
    ]);
  }
  return !response.destroyed;
}

function estimateStreamUsage(route, prompt, text) {
  if (!route.pricing) return null;
  const input_tokens=Math.max(1,Math.ceil(prompt.length/4));
  const output_tokens=Math.ceil(text.length/4);
  const cost_uusd=Math.ceil(input_tokens*Number(route.pricing.input_usd_per_million))+Math.ceil(output_tokens*Number(route.pricing.output_usd_per_million));
  return { input_tokens,output_tokens,model:route.alias,route,cost_uusd,provider_cost_uusd:null,status:"partial_estimated" };
}

function normalizeRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Request body must be a JSON object." };
  if (body.tenant_id !== undefined || body.tenantId !== undefined || body.tenant !== undefined) return { error: "Tenant identity must come from the bearer credential; tenant fields are not accepted." };
  const model = body.model;
  if (typeof model !== "string" || !model) return { error: "model is required." };
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { error: "messages must contain a user message." };
  const userMessage = [...body.messages].reverse().find(message => message?.role === "user");
  if (!userMessage || typeof userMessage.content !== "string" || !userMessage.content.trim() || userMessage.content.length > 10_000) return { error: "A non-empty user message of at most 10000 characters is required." };
  const maxTokens = body.max_tokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) return { error: "max_tokens must be an integer from 1 to 4096." };
  return { model, prompt: userMessage.content, messages: body.messages, maxTokens, stream: body.stream === true };
}

export function createGateway({ mode = "disabled", credentials, store, provider = new MockProvider(), providers, router, keyPepper, allowedOrigin = "http://127.0.0.1:4173" } = {}) {
  if (!store) throw new Error("A storage adapter must be explicitly configured.");
  const providerSet = providers instanceof Map ? providers : new Map(Object.entries(providers ?? { [provider.name ?? "mock"]: provider }));
  const policyRouter = router ?? new PolicyRouter({ providers: providerSet, store });
  const auth = createAuthenticator({ mode, credentials, store, keyPepper });
  const keyService = keyPepper && store.createApiKey ? new ApiKeyService({ store, pepper: keyPepper }) : null;
  const corsAllowedHeaders = ["Authorization", "Content-Type", "Idempotency-Key", "X-Aegis-Tenant-ID", ...(mode === "local" || mode === "test" ? ["X-Aegis-Mock-Scenario"] : [])].join(", ");
  const can = (principal, scope) => principal?.scopes?.includes("admin") || principal?.scopes?.includes(scope);
  async function handleRequest({ method = "GET", path = "/", headers = {}, body = null, signal } = {}) {
    const origin = header(headers, "origin");
    if (origin && origin !== allowedOrigin) return failure(403, "cors_origin_denied", "This origin is not allowed by the local gateway.");
    const cors = origin ? { "Access-Control-Allow-Origin": allowedOrigin, "Vary": "Origin" } : {};
    const fail = (...args) => {
      const response = failure(...args);
      response.headers = { ...response.headers, ...cors };
      return response;
    };
    if (method.toUpperCase() === "OPTIONS") return { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": corsAllowedHeaders, "Access-Control-Max-Age": "600" }, body: null };

    const url = new URL(path, "http://gateway.local");
    const pathname = url.pathname;
    const verb = method.toUpperCase();
    if (verb === "GET" && pathname === "/metrics") {
      const metricsToken=process.env.AEGIS_METRICS_TOKEN;
      if (mode === "production" && !metricsToken) return failure(404,"not_found","Metrics endpoint is not enabled.");
      if (metricsToken && !secureTokenEqual(header(headers,"authorization").replace(/^Bearer\s+/i,""),metricsToken)) return failure(401,"unauthorized","A valid metrics credential is required.");
      return { status:200,headers:{"Content-Type":"text/plain; version=0.0.4; charset=utf-8","Cache-Control":"no-store"},body:gatewayMetrics.renderPrometheus() };
    }
    if (verb === "GET" && pathname === "/healthz") return ok(200, { status: "ok", providers: [...providerSet.keys()], storage_mode: store.storageMode ?? "unknown" }, cors);

    if (pathname.startsWith("/v1/admin/")) {
      const principal = await inSpan("aegis.authenticate",{},()=>auth.authenticate(headers));
      if (!principal) return fail(401, "unauthorized", "A valid bearer credential is required.", undefined, { retryable: false });
      try {
        const result = await handleAdminRequest({ method:verb, path:pathname, url, body, principal, store, keyService, providers:providerSet, providerHealth:()=>policyRouter.getProviderHealth?.() ?? [] });
        result.headers = { ...result.headers, ...cors };
        return result;
      } catch {
        return fail(500, "control_plane_error", "The control-plane operation could not be completed safely.");
      }
    }

    if (verb === "GET" && pathname === "/v1/usage") {
      const principal = await inSpan("aegis.authenticate",{},()=>auth.authenticate(headers));
      if (!principal) return fail(401, "unauthorized", "A valid bearer credential is required.", undefined, { retryable: false });
      if (!can(principal, "usage:read") && !can(principal, "gateway:invoke")) return fail(403, "insufficient_scope", "The credential does not allow usage reads.");
      const overview = await store.getOverview(principal.tenantId);
      if (!overview) return fail(401, "unauthorized", "Credential is not mapped to an active tenant.", undefined, { retryable: false });
      return ok(200, overview, cors);
    }

    if (verb === "POST" && pathname === "/v1/chat/completions") {
      const principal = await inSpan("aegis.authenticate",{},()=>auth.authenticate(headers));
      if (!principal) return fail(401, "unauthorized", "A valid bearer credential is required.", undefined, { retryable: false });
      if (!can(principal, "gateway:invoke")) return fail(403, "insufficient_scope", "The credential does not allow gateway requests.");
      const normalized = normalizeRequest(body);
      if (normalized.error) return fail(400, "invalid_request", normalized.error);
      const idempotencyKey = header(headers, "idempotency-key").trim();
      if (!idempotencyKey || idempotencyKey.length > 200) return fail(400, "invalid_request", "A valid Idempotency-Key header is required.");

      let scenario = "success";
      const requestedScenario = header(headers, "x-aegis-mock-scenario");
      if (requestedScenario) {
        if (mode !== "local" && mode !== "test") return fail(400, "invalid_request", "Mock scenario controls are available only in local/test mode.");
        if (!["success", "budget_denial", "provider_failure"].includes(requestedScenario)) return fail(400, "invalid_request", "Unknown local mock scenario.");
        scenario = requestedScenario;
      }

      const requestHash = createHash("sha256").update(JSON.stringify({ ...normalized, scenario })).digest("hex");
      const begun = await store.beginRequest({ tenantId: principal.tenantId, idempotencyKey, requestHash });
      if (begun.kind === "conflict") return fail(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request.", begun.requestId, { retryable: false });
      if (begun.kind === "in_progress") return fail(409, "request_in_progress", "A request with this Idempotency-Key is still running.", begun.requestId, { retryable: true });
      if (begun.kind === "replay") return { ...ok(begun.status, begun.body, { ...cors, "Idempotency-Replayed": "true" }), body: begun.body };
      const requestId = begun.requestId;

      const route = await inSpan("aegis.policy.route",{model_alias:normalized.model},()=>policyRouter.resolveRoute(normalized.model,{tenantId:principal.tenantId,requestId}));
      if (!route) {
        const responseBody = { error: { code: "model_not_found", message: "The requested model alias is not allowed or has no eligible route.", request_id: requestId } };
        await store.completeRequest(begun.key, { status: 404, body: responseBody });
        return ok(404, responseBody, cors);
      }
      let quoteUusd;
      try { quoteUusd = await policyRouter.quote({ route, prompt: normalized.prompt, maxTokens: normalized.maxTokens, scenario }); }
      catch {
        const responseBody = { error: { code: "routing_unavailable", message: "No usable pricing is published for the selected route.", request_id: requestId } };
        await store.completeRequest(begun.key, { status: 503, body: responseBody });
        return ok(503, responseBody, cors);
      }
      if (route.max_cost_uusd != null && quoteUusd > route.max_cost_uusd) {
        const responseBody = { error: { code: "route_cost_ceiling", message: "The request exceeds the configured route cost ceiling.", request_id: requestId, quoted_uusd: quoteUusd, route_cost_ceiling_uusd: route.max_cost_uusd, provider_called: false } };
        await store.completeRequest(begun.key, { status: 422, body: responseBody });
        return ok(422, responseBody, cors);
      }
      const failoverRoutes=await policyRouter.getFailovers(route,{prompt:normalized.prompt,maxTokens:normalized.maxTokens,scenario});
      const admission = await inSpan("aegis.budget.reserve",{},()=>store.reserve({ tenantId: principal.tenantId, requestId, quoteUusd, quoteTokens:Math.ceil(normalized.prompt.length/4)+normalized.maxTokens, userId: principal.userId, keyId: principal.keyId, route }));
      if (!admission.admitted) {
        gatewayMetrics.increment("aegis_budget_denials_total",{reason:admission.reason??"budget_exceeded"});
        const budget = await store.getBudget(principal.tenantId);
        const remaining = budget.limit_uusd - budget.settled_uusd - budget.reserved_uusd;
        const body = { error: {
          code: admission.reason ?? "budget_exceeded",
          message: admission.reason === "quota_exceeded" ? "The request exceeds an active request, token, cost, or concurrency quota." : `Request quote ${quoteUusd} uUSD exceeds the tenant's remaining budget.`,
          request_id: requestId,
          quoted_uusd: quoteUusd,
          remaining_uusd: remaining,
          budget,
          provider_called: false,
          retryable: admission.reason === "quota_exceeded" || admission.reason === "concurrency_limit",
          ...(admission.retry_after ? { retry_after: admission.retry_after } : admission.period ? { retry_after: Math.max(1, Math.ceil((Date.parse(admission.window_end) - Date.now()) / 1000)) } : {})
        } };
        await store.completeRequest(begun.key, { status: 429, body });
        return ok(429, body, { ...cors, ...(body.error.retry_after ? { "Retry-After": String(body.error.retry_after) } : {}) });
      }

      const reservationId = admission.reservation.reservation_id;
      if (normalized.stream) {
        if (!providerSet.get(route.provider)?.stream && !failoverRoutes.some(candidate=>providerSet.get(candidate.provider)?.stream)) {
          await store.releaseReservation?.({ reservationId, reason:"stream_unsupported" });
          const responseBody={error:{code:"streaming_unsupported",message:"The selected provider route does not support streaming.",request_id:requestId,provider_called:false}};
          await store.completeRequest(begun.key,{status:501,body:responseBody});
          return ok(501,responseBody,cors);
        }
        return {
          status:200,
          headers:{...cors,"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"},
          body:null,
          writeTo:async response=>{
            const localAbort=new AbortController();
            const streamSignal=signal?AbortSignal.any([signal,localAbort.signal]):localAbort.signal;
            const maxBytes=Number(process.env.AEGIS_MAX_STREAM_BYTES||1_000_000);
            let text="",usage=null,limitReached=false,streamError=null,activeRoute=route;
            const started=Date.now();
            try {
              await writeSse(response,"planned_route",{request_id:requestId,model:route.alias,config_version:route.config_version},streamSignal);
              for await (const event of policyRouter.stream(route,{prompt:normalized.prompt,messages:normalized.messages,maxTokens:normalized.maxTokens,requestId,reservationId,scenario,signal:streamSignal,failoverRoutes,beforeProviderStart:(candidate,attempt)=>store.markProviderStarted?.({reservationId,provider:candidate.provider,configVersion:candidate.config_version,pricingVersion:candidate.pricing_version,route:candidate,attempt})})) {
                if(event.selectedRoute&&event.selectedRoute.provider!==activeRoute.provider){activeRoute=event.selectedRoute;await writeSse(response,"route",{request_id:requestId,route:activeRoute},streamSignal);}
                if (event.type==="meta" && event.provider_request_id) await store.markProviderRequest?.(reservationId,event.provider_request_id);
                if (event.type==="delta") {
                  const next=text+event.text;
                  if (Buffer.byteLength(next,"utf8")>maxBytes || Math.ceil(next.length/4)>normalized.maxTokens) {
                    limitReached=true;
                    streamError={code:"response_limit_exceeded",message:"The response exceeded the configured stream limit."};
                    localAbort.abort();
                    continue;
                  }
                  text=next;
                  if (!response.destroyed) await writeSse(response,null,{id:requestId,object:"chat.completion.chunk",choices:[{index:0,delta:{content:event.text},finish_reason:null}]},streamSignal);
                }
                if (event.type==="usage") usage=event.usage;
              }
            } catch (error) {
              streamError=streamError??error;
            }
            const disconnected=signal?.aborted||response.destroyed;
            if (!usage && text) usage=estimateStreamUsage(activeRoute,normalized.prompt,text);
            if (usage && Number.isSafeInteger(usage.cost_uusd) && usage.cost_uusd<=quoteUusd) {
              const partial=disconnected||limitReached||usage.status==="partial"||usage.status==="partial_estimated";
              const usageWithVersions={...usage,route:activeRoute,pricing_version:activeRoute.pricing_version,config_version:activeRoute.config_version,status:partial?(usage.status?.startsWith("partial")?usage.status:"partial"):"completed"};
              recordProviderCostMismatch(activeRoute,usageWithVersions);
              const settled=await store.settle({reservationId,usage:usageWithVersions});
              const budget=await store.getBudget(principal.tenantId);
              const record={id:requestId,model:normalized.model,route:activeRoute,streamed:true,usage:{prompt_tokens:settled.entry.input_tokens,completion_tokens:settled.entry.output_tokens,total_tokens:settled.entry.total_tokens,cost_uusd:settled.entry.cost_uusd,status:settled.entry.status},budget,completed_at:new Date().toISOString(),duration_ms:Date.now()-started};
              await store.completeRequest(begun.key,{status:200,body:record});
              if (!response.destroyed) {
                await writeSse(response,"usage",record.usage,streamSignal);
                if (streamError) await writeSse(response,"error",streamError.code?streamError:{code:"stream_interrupted",message:"The response ended early; partial usage was settled."},streamSignal);
                await writeSse(response,null,"[DONE]",streamSignal);
              }
            } else {
              gatewayMetrics.increment("aegis_reconciliation_pending_total",{provider:activeRoute.provider});
              await store.markReconcileRequired(reservationId,{provider:activeRoute.provider});
              const record={error:{code:"reconcile_required",message:"Provider usage was not confirmed. The reservation remains pending reconciliation.",request_id:requestId,settlement_state:"reconcile_required",reserved_uusd:quoteUusd}};
              await store.completeRequest(begun.key,{status:502,body:record});
              if (!response.destroyed) {
                await writeSse(response,"error",record.error,streamSignal);
                await writeSse(response,null,"[DONE]",streamSignal);
              }
            }
            if (!response.writableEnded&&!response.destroyed) response.end();
          }
        };
      }
      try {
        const providerStartedAt=Date.now();
        const providerResult = await inSpan("aegis.provider.invoke",{provider:route.provider,model:route.model},()=>policyRouter.invoke(route,{prompt:normalized.prompt,messages:normalized.messages,maxTokens:normalized.maxTokens,requestId,reservationId,scenario,signal,failoverRoutes,onProviderRequestId:providerRequestId=>store.markProviderRequest?.(reservationId,providerRequestId),beforeProviderStart:(candidate,attempt)=>store.markProviderStarted?.({reservationId,provider:candidate.provider,configVersion:candidate.config_version,pricingVersion:candidate.pricing_version,route:candidate,attempt})}));
        const activeRoute=providerResult.selectedRoute??route;
        gatewayMetrics.observe("aegis_provider_latency_ms",Date.now()-providerStartedAt,{provider:activeRoute.provider});
        if (providerResult.kind === "failure") {
          gatewayMetrics.increment("aegis_provider_errors_total",{provider:activeRoute.provider});
          gatewayMetrics.increment("aegis_reconciliation_pending_total",{provider:activeRoute.provider});
          await store.markReconcileRequired(reservationId, { provider: activeRoute.provider, providerRequestId: providerResult.provider_request_id });
          const body = { error: {
            code: "provider_error",
            message: providerResult.message,
            request_id: requestId,
            settlement_state: "reconcile_required",
            reserved_uusd: quoteUusd,
            budget: await store.getBudget(principal.tenantId),
            retryable: false
          } };
          await store.completeRequest(begun.key, { status: 502, body });
          return ok(502, body, cors);
        }

        if (providerResult.provider_request_id) await store.markProviderRequest?.(reservationId, providerResult.provider_request_id);
        const usage = { ...providerResult.usage, route:activeRoute, pricing_version: activeRoute.pricing_version, config_version: activeRoute.config_version };
        recordProviderCostMismatch(activeRoute,usage);
        const settled = await inSpan("aegis.ledger.settle",{provider:activeRoute.provider},()=>store.settle({reservationId,usage}));
        const budget = await store.getBudget(principal.tenantId);
        const responseBody = {
          id: requestId,
          model: normalized.model,
          route:activeRoute,
          choices: [{ message: { role: "assistant", content: providerResult.response }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: settled.entry.input_tokens,
            completion_tokens: settled.entry.output_tokens,
            total_tokens: settled.entry.total_tokens,
            cost_uusd: settled.entry.cost_uusd
          },
          budget
        };
        await store.completeRequest(begun.key, { status: 200, body: responseBody });
        return ok(200, responseBody, cors);
      } catch (error) {
        if (error instanceof ProviderError && !error.outcomeUnknown) {
          await store.releaseReservation?.({ reservationId, reason: error.code });
          const unavailable=["provider_overloaded","provider_circuit_open","client_cancelled"].includes(error.code);
          const status=unavailable?503:502;
          const responseBody = { error: { code: error.code, message: error.message, request_id: requestId, settlement_state: "released", provider_called: false, retryable: error.retryable, ...(error.retryAfter?{retry_after:error.retryAfter}:{}) } };
          await store.completeRequest(begun.key, { status, body: responseBody });
          return ok(status, responseBody, { ...cors, ...(error.retryAfter?{"Retry-After":String(error.retryAfter)}:{}) });
        }
        if (error?.requestId) await store.markProviderRequest?.(reservationId, error.requestId);
        gatewayMetrics.increment("aegis_provider_errors_total",{provider:error?.provider??route.provider});
        gatewayMetrics.increment("aegis_reconciliation_pending_total",{provider:error?.provider??route.provider});
        await store.markReconcileRequired(reservationId, { provider: error?.provider??route.provider, providerRequestId: error?.requestId });
        const body = { error: {
          code: "provider_error",
          message: "The provider result could not be safely settled.",
          request_id: requestId,
          settlement_state: "reconcile_required",
          reserved_uusd: quoteUusd,
          budget: await store.getBudget(principal.tenantId),
          retryable: false
        } };
        await store.completeRequest(begun.key, { status: 502, body });
        return ok(502, body, cors);
      }
    }

    if (pathname === "/v1/chat/completions" || pathname === "/v1/usage") return fail(405, "method_not_allowed", "Method not allowed.");
    return fail(404, "not_found", "Route not found.");
  }

  async function handle(input={}) {
    const method=String(input.method??"GET").toUpperCase();
    const route=String(input.path??"/").split("?")[0];
    const metricRoute=route==="/v1/chat/completions"?"chat.completions":route==="/v1/usage"?"usage":route.startsWith("/v1/admin/")?"admin":route==="/healthz"?"health":"other";
    const started=Date.now();
    gatewayMetrics.increment("aegis_gateway_requests_total",{method,route:metricRoute});
    try{
      const result=await runInRequestContext(input.headers??{},()=>inSpan("aegis.gateway.request",{"http.request.method":method,"http.route":metricRoute},()=>handleRequest(input)));
      gatewayMetrics.increment("aegis_gateway_responses_total",{method,route:metricRoute,status:String(result.status)});
      return result;
    }
    finally{gatewayMetrics.observe("aegis_gateway_overhead_ms",Date.now()-started,{method,route:metricRoute});}
  }

  return { handle, store, provider, mode, allowedOrigin };
}

function recordProviderCostMismatch(route,usage){
  if(Number.isSafeInteger(usage.provider_cost_uusd)&&Number.isSafeInteger(usage.cost_uusd)&&usage.provider_cost_uusd!==usage.cost_uusd){
    gatewayMetrics.increment("aegis_provider_cost_mismatch_total",{provider:route.provider});
  }
}

function secureTokenEqual(actual,expected) {
  if(typeof actual!=="string"||!actual)return false;
  const a=Buffer.from(actual),b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}
