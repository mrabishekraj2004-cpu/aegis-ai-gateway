function normalizeOverview(body) {
  const budget = body?.budget;
  if (!budget || !Array.isArray(body?.entries)) throw new Error("Unexpected usage overview response shape.");
  return {
    tenantId: body.tenant?.id ?? body.tenant_id ?? null,
    tenantName: body.tenant?.name ?? body.tenant_name ?? "Authenticated tenant",
    initials: (body.tenant?.name ?? body.tenant_name ?? "T").slice(0, 1).toUpperCase(),
    budget: {
      limit_uusd: Number(budget.limit_uusd),
      settled_uusd: Number(budget.settled_uusd),
      reserved_uusd: Number(budget.reserved_uusd ?? 0),
      window_start: budget.window_start,
      window_end: budget.window_end
    },
    entries: body.entries.map(entry => ({ ...entry, request_id: entry.request_id ?? entry.id }))
  };
}

export function createHttpAdapter({ baseUrl = "", getAccessToken, fetchImpl = fetch, makeIdempotencyKey, localDemoMode = false } = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const makeKey = makeIdempotencyKey ?? (() => globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const assertBase = () => {
    if (!base) throw new Error("API mode requires AEGIS_CONFIG.apiBaseUrl.");
  };

  async function headers(extra = {}) {
    if (typeof getAccessToken !== "function") throw new Error("API mode requires an authenticated getAccessToken function.");
    const token = await getAccessToken();
    if (!token) throw new Error("No access token is available for the gateway API.");
    return { "Authorization": `Bearer ${token}`, "Accept": "application/json", ...extra };
  }

  async function readJson(response) {
    try { return await response.json(); }
    catch { return {}; }
  }

  async function adminRequest(path,{method="GET",body}={}) {
    assertBase();
    const response=await fetchImpl(`${base}${path}`,{method,headers:await headers({"Content-Type":"application/json"}),...(body===undefined?{}:{body:JSON.stringify(body)})});
    const payload=await readJson(response);
    if(!response.ok)throw new Error(payload?.error?.message??`Control-plane request failed (${response.status}).`);
    return payload;
  }

  return {
    mode: "api",
    async listTenants() { return []; },
    async getOverview() {
      assertBase();
      const [healthResponse, response] = await Promise.all([
        fetchImpl(`${base}/healthz`, { headers: { "Accept": "application/json" } }),
        fetchImpl(`${base}/v1/usage`, { headers: await headers() })
      ]);
      const health = await readJson(healthResponse);
      const body = await readJson(response);
      if (!healthResponse.ok) throw new Error(health?.error?.message ?? `Gateway health check failed (${healthResponse.status}).`);
      if (!response.ok) throw new Error(body?.error?.message ?? `Usage request failed (${response.status}).`);
      return { ...normalizeOverview(body), storageMode: health.storage_mode ?? "unknown" };
    },
    async submitRequest({ model = "demo-model", prompt, maxTokens = 128, scenario = "success" }) {
      assertBase();
      const scenarioHeaders = localDemoMode && scenario === "failure"
        ? { "X-Aegis-Mock-Scenario": "provider_failure" }
        : {};
      const response = await fetchImpl(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: await headers({ "Content-Type": "application/json", "Idempotency-Key": makeKey(), ...scenarioHeaders }),
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: Number(maxTokens) })
      });
      const body = await readJson(response);
      const error = body?.error ?? {};
      if (response.status === 429 || error.code === "budget_exceeded") {
        const rawBudget = body.budget ?? error.budget;
        return { kind: "denied", requestId: error.request_id ?? body.id ?? "", code: error.code ?? "budget_exceeded", quote_uusd: Number(error.quoted_uusd ?? error.quote_uusd ?? 0), remaining_uusd: Number(error.remaining_uusd ?? rawBudget?.remaining_uusd ?? 0), budget: rawBudget ? normalizeBudget(rawBudget) : null, providerCalled: false, retryAfter: Number(response.headers.get("Retry-After") ?? 0) };
      }
      if (response.status === 502 || error.code === "provider_error") {
        const rawBudget = body.budget ?? error.budget;
        return { kind: "failure", requestId: error.request_id ?? body.id ?? "", code: "provider_error", message: error.message ?? "Provider request failed.", providerCalled: true, settlement_state: error.settlement_state ?? "reconcile_required", reserved_uusd: error.reserved_uusd == null && error.quoted_uusd == null ? null : Number(error.reserved_uusd ?? error.quoted_uusd), budget: rawBudget ? normalizeBudget(rawBudget) : null };
      }
      if (!response.ok) throw new Error(error.message ?? `Gateway request failed (${response.status}).`);
      return {
        kind: "success", requestId: body.id, response: body.choices?.[0]?.message?.content ?? "",
        route: body.route ?? { provider: "unknown", model: body.model ?? model },
        usage: { request_id: body.id, model: body.model ?? model, route: body.route, input_tokens: body.usage?.prompt_tokens ?? 0, output_tokens: body.usage?.completion_tokens ?? 0, total_tokens: body.usage?.total_tokens ?? 0, cost_uusd: Number(body.usage?.cost_uusd ?? 0), status: "completed", created_at: new Date().toISOString() },
        budget: body.budget ? normalizeBudget(body.budget) : null, providerCalled: true
      };
    },
    listApiKeys:()=>adminRequest("/v1/admin/api-keys"),
    createApiKey:body=>adminRequest("/v1/admin/api-keys",{method:"POST",body}),
    revokeApiKey:(keyId,reason)=>adminRequest(`/v1/admin/api-keys/${encodeURIComponent(keyId)}`,{method:"DELETE",body:{reason}}),
    rotateApiKey:(keyId,reason)=>adminRequest(`/v1/admin/api-keys/${encodeURIComponent(keyId)}/rotate`,{method:"POST",body:{reason}}),
    listMembers:()=>adminRequest("/v1/admin/members"),
    createMember:body=>adminRequest("/v1/admin/members",{method:"POST",body}),
    listTenants:()=>adminRequest("/v1/admin/tenants"),
    createTenant:body=>adminRequest("/v1/admin/tenants",{method:"POST",body}),
    bootstrapTenantOwner:(tenantId,body)=>adminRequest(`/v1/admin/tenants/${encodeURIComponent(tenantId)}/members`,{method:"POST",body}),
    listRoutingConfigs:()=>adminRequest("/v1/admin/routing-configs"),
    createRoutingDraft:body=>adminRequest("/v1/admin/routing-configs",{method:"POST",body}),
    publishRoutingConfig:(version,reason)=>adminRequest(`/v1/admin/routing-configs/${encodeURIComponent(version)}/publish`,{method:"POST",body:{reason}}),
    listQuotas:()=>adminRequest("/v1/admin/quotas"),
    createQuota:body=>adminRequest("/v1/admin/quotas",{method:"POST",body}),
    listPricing:()=>adminRequest("/v1/admin/pricing"),
    createPricing:body=>adminRequest("/v1/admin/pricing",{method:"POST",body}),
    listReconciliation:()=>adminRequest("/v1/admin/reconciliation"),
    resolveReconciliation:(reservationId,body)=>adminRequest(`/v1/admin/reconciliation/${encodeURIComponent(reservationId)}/resolve`,{method:"POST",body}),
    listAuditEvents:()=>adminRequest("/v1/admin/audit-events"),
    getProviderHealth:()=>adminRequest("/v1/admin/provider-health")
  };
}

function normalizeBudget(budget) {
  return {
    limit_uusd: Number(budget.limit_uusd),
    settled_uusd: Number(budget.settled_uusd),
    reserved_uusd: Number(budget.reserved_uusd ?? 0),
    window_start: budget.window_start,
    window_end: budget.window_end
  };
}
