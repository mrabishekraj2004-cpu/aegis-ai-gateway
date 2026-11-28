// @ts-check
import { randomUUID } from "node:crypto";
/** @param {number} status @param {any} body @param {Record<string, string>} [headers] */
const response = (status, body, headers = {}) => ({ status, headers: { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", ...headers }, body });
/** @param {import("./contracts.js").TenantPrincipal} principal @param {string} name */
const scope = (principal, name) => principal?.scopes?.includes("admin") || principal?.scopes?.includes(name);
/** @param {import("./contracts.js").TenantPrincipal} principal */
const adminRole = principal => ["owner","admin"].includes(principal?.role);
/** @param {import("./contracts.js").TenantPrincipal} principal */
const platformAdmin = principal => principal?.platformAdmin === true;
const platformRoutes = new Set(["/v1/admin/tenants", "/v1/admin/pricing", "/v1/admin/provider-health"]);
/** @param {string} path */
const platformTenantMemberRoute = path => /^\/v1\/admin\/tenants\/[A-Za-z0-9_-]+\/members$/.test(path);

/** @param {any} body */
function requireReason(body) { return typeof body?.reason === "string" && body.reason.trim().length >= 3; }
/** @param {unknown} value */
function validEvidenceReference(value) { return typeof value === "string" && value.length >= 3 && value.length <= 500 && /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,499}$/.test(value); }
/** @param {unknown} value */
function validNonnegativeInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** @param {unknown} value */
function validProviderRequestId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && Array.from(value).every(character => {
    const code=character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

/** @param {import("./contracts.js").AdminRequest} options */
export async function handleAdminRequest({ method, path, url, body, principal, store, keyService, providers = new Map(), providerHealth = () => /** @type {Array<{name:string}>} */([]) }) {
  const readAllowed = adminRole(principal) && (scope(principal,"control:read") || scope(principal,"control:write"));
  const writeAllowed = adminRole(principal) && scope(principal,"control:write");
  if (!readAllowed) return response(403,{error:{code:"insufficient_scope",message:"An owner or administrator credential with control-plane access is required."}});
  const verb=method.toUpperCase();
  if ((platformRoutes.has(path) || platformTenantMemberRoute(path)) && !platformAdmin(principal)) return response(403,{error:{code:"platform_admin_required",message:"This control-plane resource is restricted to platform administrators."}});
  if (verb==="GET" && path==="/v1/admin/tenants") return response(200,{tenants:await store.listTenants()});
  if (verb==="POST" && path==="/v1/admin/tenants") {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (typeof body?.tenant_id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.tenant_id) || !body?.name || !Number.isSafeInteger(body.monthly_limit_uusd) || body.monthly_limit_uusd<0 || !requireReason(body)) return response(400,{error:{code:"invalid_request",message:"A tenant ID containing 1-80 letters, digits, underscores, or hyphens, name, non-negative monthly limit, and reason are required."}});
    const tenant=await store.createTenant({tenantId:body.tenant_id,name:body.name,monthlyLimitUusd:body.monthly_limit_uusd,actor:principal.userId,reason:body.reason});
    return response(201,tenant);
  }
  const tenantBootstrap=path.match(/^\/v1\/admin\/tenants\/([A-Za-z0-9_-]+)\/members$/);
  if (verb==="POST" && tenantBootstrap) {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!body?.user_id || !body?.email || !body?.display_name || !requireReason(body)) return response(400,{error:{code:"invalid_request",message:"user_id, email, display_name, and reason are required to assign the first tenant owner."}});
    const result=await store.bootstrapTenantOwner({tenantId:tenantBootstrap[1],userId:body.user_id,email:body.email,displayName:body.display_name,actor:principal.userId,reason:body.reason});
    if (result.kind==="tenant_not_found") return response(404,{error:{code:"tenant_not_found",message:"Tenant not found or inactive."}});
    if (result.kind==="already_bootstrapped") return response(409,{error:{code:"tenant_already_bootstrapped",message:"Tenant already has an active member; use tenant-scoped member administration."}});
    return response(201,{tenant_id:tenantBootstrap[1],user_id:body.user_id,role:"owner"});
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
  const rollback=path.match(/^\\/v1\\/admin\\/routing-configs\\/(\\d+)\\/rollback$/);
  if (verb==="POST" && rollback) {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!requireReason(body)) return response(400,{error:{code:"invalid_request",message:"A reason is required to roll back routing configuration."}});
    const versionId=Number(rollback[1]);
    if (!Number.isSafeInteger(versionId)) return response(400,{error:{code:"invalid_request",message:"Routing configuration version must be a safe integer."}});
    const row=await store.rollbackRoutingConfig({versionId,tenantId:principal.tenantId,actor:principal.userId,reason:body.reason});
    return row?response(200,row):response(404,{error:{code:"configuration_not_found",message:"Published routing version not found for this tenant."}});
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
  const reconciliationResolution=path.match(/^\/v1\/admin\/reconciliation\/([A-Za-z0-9_-]+)\/resolve$/);
  if (verb==="POST" && reconciliationResolution) {
    if (!writeAllowed) return response(403,{error:{code:"insufficient_scope",message:"control:write is required."}});
    if (!requireReason(body) || body.reason.trim().length > 500 || !validEvidenceReference(body.evidence_ref)) return response(400,{error:{code:"invalid_request",message:"A reason (3-500 characters) and sanitized evidence reference (3-500 letters, digits, or . _ : / # -) are required."}});
    if (!["settled","not_executed"].includes(body.outcome)) return response(400,{error:{code:"invalid_request",message:"outcome must be settled or not_executed."}});
    let usage=null;
    if (body.outcome==="settled") {
      if (!validProviderRequestId(body.provider_request_id)) return response(400,{error:{code:"invalid_request",message:"A valid provider request ID is required when settling usage."}});
      if (!validNonnegativeInteger(body.input_tokens) || !validNonnegativeInteger(body.output_tokens) || !validNonnegativeInteger(body.cost_uusd) || (body.provider_cost_uusd!=null && !validNonnegativeInteger(body.provider_cost_uusd)) || !["completed","partial"].includes(body.status ?? "completed")) return response(400,{error:{code:"invalid_request",message:"Settled usage requires non-negative safe integer token and cost values and a completed or partial status."}});
      usage={input_tokens:body.input_tokens,output_tokens:body.output_tokens,cost_uusd:body.cost_uusd,provider_cost_uusd:body.provider_cost_uusd ?? null,status:body.status ?? "completed"};
    }
    const result=await store.resolveReconciliation({
      reservationId:reconciliationResolution[1],tenantId:principal.tenantId,actor:principal.userId,
      reason:body.reason.trim(),evidenceRef:body.evidence_ref,outcome:body.outcome,
      providerRequestId:body.outcome==="settled"?body.provider_request_id:null,usage,
      correlationId:randomUUID()
    });
    if (result.kind==="not_found") return response(404,{error:{code:"reconciliation_not_found",message:"Reconciliation case not found."}});
    if (result.kind==="not_dead_letter") return response(409,{error:{code:"reconciliation_not_dead_letter",message:"Only dead-letter cases can be resolved manually."}});
    if (result.kind==="receipt_mismatch") return response(409,{error:{code:"provider_receipt_mismatch",message:"The provider request ID does not match the saved receipt."}});
    if (result.kind==="provider_route_missing") return response(422,{error:{code:"provider_route_missing",message:"The stored provider route is missing; usage cannot be safely priced."}});
    if (result.kind==="cost_exceeds_reservation") return response(422,{error:{code:"cost_exceeds_reservation",message:"Verified provider cost exceeds the reserved amount."}});
    if (result.kind==="already_resolved") return response(200,{resolved:true,duplicate:true,outcome:result.outcome});
    return response(200,{resolved:true,duplicate:false,outcome:result.outcome,usage:result.entry ?? null});
  }
  if (verb==="GET" && path==="/v1/admin/reconciliation") return response(200,await store.listReconciliationJobs(principal.tenantId));
  if (verb==="GET" && path==="/v1/admin/audit-events") return response(200,{events:await store.listAuditEvents(principal.tenantId,{limit:Number(url.searchParams.get("limit") ?? 100),beforeId:url.searchParams.get("before_id")})});
  if (verb==="GET" && path==="/v1/admin/provider-health") return response(200,{providers:providerHealth().map(item=>({...item,configured:providers.has(item.name)}))});
  return response(404,{error:{code:"not_found",message:"Control-plane route not found."}});
}

/** @param {any} config */
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
