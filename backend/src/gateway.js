import { createHash } from "node:crypto";
import { createAuthenticator } from "./auth.js";
import { MockProvider } from "./mock-provider.js";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const ok = (status, body, headers = {}) => ({ status, headers: { ...jsonHeaders, ...headers }, body });
const failure = (status, code, message, requestId = undefined, extra = {}) => ok(status, { error: { code, message, ...(requestId ? { request_id: requestId } : {}), ...extra } });
const header = (headers, key) => {
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === lower) return value;
  return "";
};

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
  return { model, prompt: userMessage.content, maxTokens };
}

export function createGateway({ mode = "disabled", credentials, store, provider = new MockProvider(), allowedOrigin = "http://127.0.0.1:4173" } = {}) {
  if (!store) throw new Error("A storage adapter must be explicitly configured.");
  const auth = createAuthenticator({ mode, credentials });
  const corsAllowedHeaders = ["Authorization", "Content-Type", "Idempotency-Key", ...(mode === "local" || mode === "test" ? ["X-Aegis-Mock-Scenario"] : [])].join(", ");

  async function handle({ method = "GET", path = "/", headers = {}, body = null } = {}) {
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
    if (verb === "GET" && pathname === "/healthz") return ok(200, { status: "ok", provider: "mock", storage_mode: store.storageMode ?? "unknown" }, cors);

    if (verb === "GET" && pathname === "/v1/usage") {
      const principal = auth.authenticate(headers);
      if (!principal) return fail(401, "unauthorized", "A valid bearer credential is required.", undefined, { retryable: false });
      const overview = await store.getOverview(principal.tenantId);
      if (!overview) return fail(401, "unauthorized", "Credential is not mapped to an active tenant.", undefined, { retryable: false });
      return ok(200, overview, cors);
    }

    if (verb === "POST" && pathname === "/v1/chat/completions") {
      const principal = auth.authenticate(headers);
      if (!principal) return fail(401, "unauthorized", "A valid bearer credential is required.", undefined, { retryable: false });
      const normalized = normalizeRequest(body);
      if (normalized.error) return fail(400, "invalid_request", normalized.error);
      const route = provider.resolveRoute(normalized.model);
      if (!route) return fail(404, "model_not_found", "The requested model alias is not configured.");
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

      const quoteUusd = provider.quote({ route, prompt: normalized.prompt, maxTokens: normalized.maxTokens, scenario });
      const admission = await store.reserve({ tenantId: principal.tenantId, requestId, quoteUusd });
      if (!admission.admitted) {
        const budget = await store.getBudget(principal.tenantId);
        const remaining = budget.limit_uusd - budget.settled_uusd - budget.reserved_uusd;
        const body = { error: {
          code: "budget_exceeded",
          message: `Request quote ${quoteUusd} uUSD exceeds the tenant's remaining budget.`,
          request_id: requestId,
          quoted_uusd: quoteUusd,
          remaining_uusd: remaining,
          budget,
          provider_called: false,
          retryable: false
        } };
        await store.completeRequest(begun.key, { status: 429, body });
        return ok(429, body, cors);
      }

      const reservationId = admission.reservation.reservation_id;
      try {
        const providerResult = await provider.invoke({ route, prompt: normalized.prompt, maxTokens: normalized.maxTokens, requestId, reservationId, scenario });
        if (providerResult.kind === "failure") {
          await store.markReconcileRequired(reservationId);
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

        const settled = await store.settle({ reservationId, usage: providerResult.usage });
        const budget = await store.getBudget(principal.tenantId);
        const responseBody = {
          id: requestId,
          model: normalized.model,
          route,
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
        await store.markReconcileRequired(reservationId);
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

  return { handle, store, provider, mode, allowedOrigin };
}
