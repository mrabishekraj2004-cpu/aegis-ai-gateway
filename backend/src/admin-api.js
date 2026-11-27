import { randomUUID } from "node:crypto";

const response = (status, body, headers = {}) => ({ status, headers: { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", ...headers }, body });
const scope = (principal, name) => principal?.scopes?.includes("admin") || principal?.scopes?.includes(name);
const adminRole = principal => ["owner","admin"].includes(principal?.role);

function requireReason(body) { return typeof body?.reason === "string" && body.reason.trim().length >= 3; }

export async function handleAdminRequest({ method, path, url, body, principal, store, keyService, providers = new Map(), providerHealth = () => [] }) {
  const readAllowed = adminRole(principal) && (scope(principal,"control:read") || scope(principal,"control:write"));
  const writeAllowed = adminRole(principal) && scope(principal,"control:write");
  if (!readAllowed) return response(403,{error:{code:"insufficient_scope",message:"An owner or administrator credential with control-plane access is required."}});
  const verb=method.toUpperCase();
  if (verb==="GET" && path==="/v1/admin/tenants") return response(200,{tenants:await store.listTenants()});
  if (verb==="POST" && path==="/v1/admin/tenants") {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!body?.tenant_id || !body?.name || !Number.isSafeInteger(body.monthly_limit_uusd) || body.monthly_limit_uusd<0 || !requireReason(body)) return response(400,{error:{code:"invalid_request",message:"tenant_id, name, non-negative monthly_limit_uusd, and reason are required."}});
    const tenant=await store.createTenant({tenantId:body.tenant_id,name:body.name,monthlyLimitUusd:body.monthly_limit_uusd,actor:principal.userId,reason:body.reason});
    return response(201,tenant);
  }
  if (verb==="GET" && path==="/v1/admin/members") return response(200,{members:await store.listMembers(principal.tenantId)});
  if (verb==="POST" && path==="/v1/admin/members") {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!body?.user_id || !body?.email || !body?.display_name || !["owner","admin","operator","viewer"].includes(body?.role) || !requireReason(body)) return response(400,{error:{code:"invalid_request",message:"user_id, email, display_name, role, and reason are required."}});
    await store.upsertMembership({tenantId:principal.tenantId,userId:body.user_id,email:body.email,displayName:body.display_name,role:body.role,actor:principal.userId,reason:body.reason});
    return response(201,{user_id:body.user_id,role:body.role});
  }
  if (verb==="GET" && path==="/v1/admin/api-keys") return response(200,{keys:await store.listApiKeys(principal.tenantId)});
  if (verb==="POST" && path==="/v1/admin/api-keys") {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!keyService) return response(503,{error:{code:"key_management_unavailable",message:"API-key pepper is not configured."}});
    if (!requireReason(body)) return response(400,{error:{code:"invalid_request",message:"A reason is required for API-key creation."}});
    const key=await keyService.create({tenantId:principal.tenantId,userId:body.user_id ?? principal.userId,name:body.name,scopes:body.scopes,expiresAt:body.expires_at,createdBy:principal.userId,reason:body.reason,environment:body.environment ?? "live"});
    return response(201,key);
  }
  const rotate=path.match(/^\/v1\/admin\/api-keys\/([^/]+)\/rotate$/);
  if (verb==="POST" && rotate) {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!requireReason(body)) return response(400,{error:{code:"invalid_request",message:"A reason is required for key rotation."}});
    if (!keyService) return response(503,{error:{code:"key_management_unavailable",message:"API-key pepper is not configured."}});
    return response(201,await keyService.rotate({keyId:rotate[1],tenantId:principal.tenantId,actor:principal.userId,reason:body.reason}));
  }
  const keyId=path.match(/^\/v1\/admin\/api-keys\/([^/]+)$/);
  if (verb==="DELETE" && keyId) {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!requireReason(body)) return response(400,{error:{code:"invalid_request",message:"A reason is required for key revocation."}});
    if (!keyService) return response(503,{error:{code:"key_management_unavailable",message:"API-key pepper is not configured."}});
    const revoked=await keyService.revoke({keyId:keyId[1],tenantId:principal.tenantId,actor:principal.userId,reason:body.reason});
    return revoked?response(200,{revoked:true}):response(404,{error:{code:"key_not_found",message:"Active API key not found."}});
  }
  if (verb==="GET" && path==="/v1/admin/routing-configs") return response(200,{configurations:await store.listRoutingConfigs(principal.tenantId)});
  if (verb==="POST" && path==="/v1/admin/routing-configs") {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    const invalid=validateRoutingConfig(body?.config);
    if (invalid) return response(400,{error:{code:"invalid_configuration",message:invalid}});
    if (!requireReason(body)) return response(400,{error:{code:"invalid_request",message:"A reason is required for routing configuration changes."}});
    const row=await store.createRoutingDraft({tenantId:principal.tenantId,config:body.config,actor:principal.userId,reason:body.reason,effectiveAt:body.effective_at ?? null});
    return response(201,row);
  }
  const publish=path.match(/^\/v1\/admin\/routing-configs\/(\d+)\/publish$/);
  if (verb==="POST" && publish) {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!requireReason(body)) return response(400,{error:{code:"invalid_request",message:"A reason is required to publish configuration."}});
    const row=await store.publishRoutingConfig({versionId:Number(publish[1]),tenantId:principal.tenantId,actor:principal.userId,reason:body.reason});
    return row?response(200,row):response(404,{error:{code:"configuration_not_found",message:"Draft configuration not found."}});
  }
  if (verb==="GET" && path==="/v1/admin/pricing") return response(200,{versions:await store.listPricingVersions()});
  if (verb==="POST" && path==="/v1/admin/pricing") {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!requireReason(body) || !body?.provider || !body?.model || !body?.region || !body?.unit || !body?.version || !body?.effective_at) return response(400,{error:{code:"invalid_request",message:"Provider, model, region, unit, version, effective_at, and reason are required."}});
    const row=await store.createPricingVersion({provider:body.provider,model:body.model,region:body.region,unit:body.unit,inputUsdPerMillion:body.input_usd_per_million ?? 0,outputUsdPerMillion:body.output_usd_per_million ?? 0,fixedUsdPerUnit:body.fixed_usd_per_unit ?? 0,version:body.version,effectiveAt:body.effective_at,effectiveUntil:body.effective_until ?? null,actor:principal.userId,reason:body.reason});
    return response(201,row);
  }
  if (verb==="GET" && path==="/v1/admin/quotas") return response(200,{policies:await store.listQuotaPolicies(principal.tenantId)});
  if (verb==="POST" && path==="/v1/admin/quotas") {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!requireReason(body)) return response(400,{error:{code:"invalid_request",message:"A reason is required to create a quota."}});
    const row=await store.createQuotaPolicy({tenantId:principal.tenantId,principalId:body.principal_id ?? null,apiKeyId:body.api_key_id ?? null,period:body.period,requestLimit:body.request_limit ?? null,tokenLimit:body.token_limit ?? null,costLimitUusd:body.cost_limit_uusd ?? null,concurrencyLimit:body.concurrency_limit ?? null,actor:principal.userId,reason:body.reason});
    return response(201,row);
  }
  const quotaId=path.match(/^\/v1\/admin\/quotas\/(\d+)$/);
  if (verb==="DELETE" && quotaId) {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!requireReason(body)) return response(400,{error:{code:"invalid_request",message:"A reason is required to disable a quota."}});
    return await store.deactivateQuotaPolicy({quotaId:Number(quotaId[1]),tenantId:principal.tenantId,actor:principal.userId,reason:body.reason})?response(200,{deactivated:true}):response(404,{error:{code:"quota_not_found",message:"Quota not found."}});
  }
  if (verb==="GET" && path==="/v1/admin/reconciliation") return response(200,await store.listReconciliationJobs(principal.tenantId));
  if (verb==="GET" && path==="/v1/admin/audit-events") return response(200,{events:await store.listAuditEvents(principal.tenantId,{limit:Number(url.searchParams.get("limit") ?? 100),beforeId:url.searchParams.get("before_id")})});
  if (verb==="GET" && path==="/v1/admin/provider-health") return response(200,{providers:providerHealth().map(item=>({...item,configured:providers.has(item.name)}))});
  return response(404,{error:{code:"not_found",message:"Control-plane route not found."}});
}

function validateRoutingConfig(config) {
  if (!config || typeof config!=="object" || Array.isArray(config) || !config.aliases || typeof config.aliases!=="object") return "config.aliases must be an object.";
  for (const [alias,routes] of Object.entries(config.aliases)) {
    if (!alias || !Array.isArray(routes) || !routes.length) return "Every model alias must have at least one provider route.";
    for (const route of routes) {
      if (!route?.provider || !route?.model || !Number.isFinite(Number(route.weight)) || Number(route.weight)<=0) return "Each route needs a provider, model, and positive weight.";
      if (route.max_cost_uusd!=null && (!Number.isSafeInteger(route.max_cost_uusd) || route.max_cost_uusd<0)) return "Route cost ceilings must be non-negative integers in uUSD.";
    }
  }
  if (config.tenants!=null && (typeof config.tenants!=="object" || Array.isArray(config.tenants))) return "Tenant policy configuration must be an object.";
  return null;
}
