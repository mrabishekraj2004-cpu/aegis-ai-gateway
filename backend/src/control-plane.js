import { randomUUID } from "node:crypto";

const json = value => typeof value === "string" ? JSON.parse(value) : value;

export class PostgresControlPlane {
  constructor({ pool, clock = () => new Date() } = {}) {
    if (!pool) throw new Error("PostgresControlPlane requires a PostgreSQL pool.");
    this.pool = pool;
    this.clock = clock;
  }

  async resolveNeonAuthUser({ userId, email, displayName, tenantId = null, starterLimitUusd = 340000 }) {
    if (!Number.isSafeInteger(starterLimitUusd) || starterLimitUusd < 0 || starterLimitUusd > 1_000_000_000_000) throw new Error("Starter monthly limit must be a safe non-negative micro-USD amount.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO aegis_users (user_id,email,display_name) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,active=TRUE`,
        [userId,email,displayName.slice(0,160)]
      );
      const member = await client.query(
        `SELECT m.tenant_id,m.role,t.name AS tenant_name
         FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
         WHERE m.user_id=$1 AND m.active=TRUE AND t.active=TRUE
           AND ($2::text IS NULL OR m.tenant_id=$2)
         ORDER BY m.created_at,m.tenant_id LIMIT 1`,
        [userId,tenantId]
      );
      if (member.rows[0]) {
        await client.query("COMMIT");
        return member.rows[0];
      }
      if (tenantId !== null) {
        await client.query("ROLLBACK");
        return null;
      }
      const existing = await client.query("SELECT tenant_id FROM tenant_memberships WHERE user_id=$1 AND active=TRUE LIMIT 1", [userId]);
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const newTenantId = `tenant_${randomUUID()}`;
      const tenantName = `${displayName.trim().slice(0,120) || "My"} Workspace`;
      await client.query(
        "INSERT INTO tenants (tenant_id,name,monthly_limit_uusd) VALUES ($1,$2,$3)",
        [newTenantId,tenantName,starterLimitUusd]
      );
      await client.query(
        "INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'owner')",
        [newTenantId,userId]
      );
      await client.query(
        `INSERT INTO audit_events (tenant_id,actor_id,action,reason,correlation_id,target_type,target_id,payload)
         VALUES ($1,$2,'tenant.owner_created','First verified Neon Auth session',$3,'tenant',$1,$4::jsonb)`,
        [newTenantId,userId,randomUUID(),JSON.stringify({ monthly_limit_uusd:starterLimitUusd, source:"neon_auth_signup" })]
      );
      await client.query("COMMIT");
      return { tenant_id:newTenantId,role:"owner",tenant_name:tenantName };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async authenticateApiKey(keyId) {
    const result = await this.pool.query(
      `SELECT k.key_id, k.key_hash, k.environment, k.tenant_id, k.user_id, k.name, k.scopes,
              k.expires_at, k.revoked_at, m.role
       FROM api_keys k
       JOIN tenants t ON t.tenant_id = k.tenant_id AND t.active = TRUE
       JOIN tenant_memberships m ON m.tenant_id = k.tenant_id AND m.user_id = k.user_id AND m.active = TRUE
       JOIN aegis_users u ON u.user_id = k.user_id AND u.active = TRUE
       WHERE k.key_id = $1`, [keyId]
    );
    return result.rows[0] ?? null;
  }

  async touchApiKey(keyId) {
    await this.pool.query("UPDATE api_keys SET last_used_at = now() WHERE key_id = $1 AND revoked_at IS NULL", [keyId]);
  }

  async createApiKey(key) {
    await this.pool.query(
      `INSERT INTO api_keys (key_id,key_prefix,key_hash,environment,tenant_id,user_id,name,scopes,created_by,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [key.key_id,key.key_prefix,key.key_hash,key.environment,key.tenantId,key.userId,key.name,key.scopes,key.createdBy,key.expiresAt]
    );
    await this.writeAudit({ tenantId: key.tenantId, actorId: key.createdBy, action: "api_key.created", reason: key.reason ?? "API key created", correlationId: randomUUID(), targetType: "api_key", targetId: key.key_id, payload: { name: key.name, scopes: key.scopes, expires_at: key.expiresAt } });
  }

  async getApiKey(keyId, tenantId) {
    const result = await this.pool.query(
      `SELECT key_id,key_prefix,environment,tenant_id,user_id,name,scopes,expires_at,revoked_at,last_used_at
       FROM api_keys WHERE key_id=$1 AND tenant_id=$2`, [keyId, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async rotateApiKey({ previousKeyId, tenantId, actor, reason = "Key rotation", material }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const old = await client.query("SELECT * FROM api_keys WHERE key_id=$1 AND tenant_id=$2 AND revoked_at IS NULL FOR UPDATE", [previousKeyId, tenantId]);
      if (!old.rows[0]) { await client.query("ROLLBACK"); return false; }
      await client.query("UPDATE api_keys SET revoked_at=now(),revoked_by=$2,revoke_reason='rotated' WHERE key_id=$1", [previousKeyId, actor]);
      await client.query(
        `INSERT INTO api_keys (key_id,key_prefix,key_hash,environment,tenant_id,user_id,name,scopes,created_by,expires_at,rotated_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [material.key_id,material.key_prefix,material.key_hash,material.environment,tenantId,material.userId,material.name,material.scopes,actor,material.expiresAt,previousKeyId]
      );
      await client.query(
        `INSERT INTO audit_events (tenant_id,actor_id,action,reason,correlation_id,target_type,target_id,payload)
         VALUES ($1,$2,'api_key.rotated',$3,$4,'api_key',$5,$6::jsonb)`,
        [tenantId,actor,reason,randomUUID(),material.key_id,JSON.stringify({ rotated_from: previousKeyId })]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async revokeApiKey({ keyId, tenantId, actor, reason }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "UPDATE api_keys SET revoked_at=now(),revoked_by=$3,revoke_reason=$4 WHERE key_id=$1 AND tenant_id=$2 AND revoked_at IS NULL RETURNING key_id",
        [keyId,tenantId,actor,reason]
      );
      if (!result.rowCount) { await client.query("ROLLBACK"); return false; }
      await client.query(
        `INSERT INTO audit_events (tenant_id,actor_id,action,reason,correlation_id,target_type,target_id)
         VALUES ($1,$2,'api_key.revoked',$3,$4,'api_key',$5)`, [tenantId,actor,reason,randomUUID(),keyId]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async listApiKeys(tenantId) {
    const result = await this.pool.query(
      `SELECT key_id,key_prefix,name,environment,user_id,scopes,created_by,created_at,expires_at,revoked_at,last_used_at,rotated_from
       FROM api_keys WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]
    );
    return result.rows;
  }

  async upsertMembership({ tenantId, userId, email, displayName, role, actor, reason }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO aegis_users (user_id,email,display_name) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,active=TRUE`,
        [userId,email,displayName]
      );
      await client.query(
        `INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id,user_id) DO UPDATE SET role=EXCLUDED.role,active=TRUE`, [tenantId,userId,role]
      );
      await client.query(
        `INSERT INTO audit_events (tenant_id,actor_id,action,reason,correlation_id,target_type,target_id,payload)
         VALUES ($1,$2,'membership.updated',$3,$4,'membership',$5,$6::jsonb)`,
        [tenantId,actor,reason,randomUUID(),userId,JSON.stringify({ email, role })]
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async bootstrapTenantOwner({ tenantId, userId, email, displayName, actor, reason }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tenant = await client.query("SELECT tenant_id FROM tenants WHERE tenant_id=$1 AND active=TRUE FOR UPDATE", [tenantId]);
      if (!tenant.rowCount) { await client.query("ROLLBACK"); return { kind:"tenant_not_found" }; }
      const members = await client.query("SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND active=TRUE LIMIT 1", [tenantId]);
      if (members.rowCount) { await client.query("ROLLBACK"); return { kind:"already_bootstrapped" }; }
      await client.query(
        `INSERT INTO aegis_users (user_id,email,display_name) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,active=TRUE`,
        [userId,email,displayName]
      );
      await client.query(
        `INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'owner')
         ON CONFLICT (tenant_id,user_id) DO UPDATE SET role='owner',active=TRUE`,
        [tenantId,userId]
      );
      await client.query(
        `INSERT INTO audit_events (tenant_id,actor_id,action,reason,correlation_id,target_type,target_id,payload)
         VALUES ($1,$2,'membership.owner_bootstrapped',$3,$4,'membership',$5,$6::jsonb)`,
        [tenantId,actor,reason,randomUUID(),userId,JSON.stringify({ role:"owner" })]
      );
      await client.query("COMMIT");
      return { kind:"created",tenant_id:tenantId,user_id:userId,role:"owner" };
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async listMembers(tenantId) {
    const result = await this.pool.query(
      `SELECT u.user_id,u.email,u.display_name,m.role,m.active,m.created_at
       FROM tenant_memberships m JOIN aegis_users u USING(user_id)
       WHERE m.tenant_id=$1 ORDER BY m.created_at`, [tenantId]
    );
    return result.rows;
  }

  async createRoutingDraft({ tenantId = null, config, actor, reason, effectiveAt = null }) {
    const result = await this.pool.query(
      `INSERT INTO routing_config_versions (tenant_id,state,config,created_by,reason,effective_at)
       VALUES ($1,CASE WHEN $5::timestamptz IS NULL THEN 'draft' ELSE 'scheduled' END,$2::jsonb,$3,$4,$5)
       RETURNING version_id,tenant_id,state,config,created_by,reason,created_at,effective_at,published_at`,
      [tenantId,JSON.stringify(config),actor,reason,effectiveAt]
    );
    await this.writeAudit({ tenantId, actorId: actor, action: "routing.draft_created", reason, correlationId: randomUUID(), targetType: "routing_config", targetId: String(result.rows[0].version_id), payload: { state: result.rows[0].state } });
    return result.rows[0];
  }

  async publishRoutingConfig({ versionId, tenantId = null, actor, reason }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const config = await client.query("SELECT * FROM routing_config_versions WHERE version_id=$1 AND tenant_id IS NOT DISTINCT FROM $2 AND state='draft' FOR UPDATE", [versionId,tenantId]);
      if (!config.rows[0]) { await client.query("ROLLBACK"); return null; }
      await client.query(
        `UPDATE routing_config_versions SET state='rolled_back' WHERE tenant_id IS NOT DISTINCT FROM $1 AND state='published'`, [tenantId]
      );
      const result = await client.query(
        `UPDATE routing_config_versions SET state='published',published_at=now(),effective_at=now(),reason=$2
         WHERE version_id=$1 RETURNING version_id,tenant_id,state,config,created_by,reason,created_at,effective_at,published_at`, [versionId,reason]
      );
      await client.query(
        `INSERT INTO audit_events (tenant_id,actor_id,action,reason,correlation_id,target_type,target_id)
         VALUES ($1,$2,'routing.published',$3,$4,'routing_config',$5)`, [tenantId,actor,reason,randomUUID(),String(versionId)]
      );
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async getActiveRoutingConfig(tenantId) {
    const result = await this.pool.query(
      `SELECT config,version_id,tenant_id FROM routing_config_versions
       WHERE state IN ('published','scheduled') AND (tenant_id IS NULL OR tenant_id=$1) AND (effective_at IS NULL OR effective_at <= now())
       ORDER BY (tenant_id IS NOT NULL) DESC,effective_at DESC,version_id DESC`, [tenantId]
    );
    if (!result.rows.length) return null;
    const tenant = result.rows.find(row=>row.tenant_id===tenantId);
    const global = result.rows.find(row=>row.tenant_id===null);
    const base=global?json(global.config):{};
    const override=tenant?json(tenant.config):{};
    return { ...base,...override,aliases:{...(base.aliases??{}),...(override.aliases??{})},tenants:{...(base.tenants??{}),...(override.tenants??{})},version:[global?.version_id,tenant?.version_id].filter(Boolean).join("+") };
  }

  async listRoutingConfigs(tenantId) {
    const result = await this.pool.query(
      `SELECT version_id,tenant_id,state,config,created_by,reason,created_at,effective_at,published_at
       FROM routing_config_versions WHERE tenant_id IS NULL OR tenant_id=$1 ORDER BY version_id DESC`, [tenantId]
    );
    return result.rows.map(row => ({ ...row, config: json(row.config) }));
  }

  async writeAudit({ tenantId = null, actorId, action, reason, correlationId, targetType, targetId = null, payload = {} }) {
    await this.pool.query(
      `INSERT INTO audit_events (tenant_id,actor_id,action,reason,correlation_id,target_type,target_id,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [tenantId,actorId,action,reason,correlationId,targetType,targetId,JSON.stringify(payload)]
    );
  }

  async publishIntegrationEvent({ payload, idempotencyKey }) {
    if (!idempotencyKey || !payload || typeof payload !== "object") throw new Error("An idempotency key and event payload are required.");
    const result=await this.pool.query(
      `INSERT INTO integration_events (event_key,event_type,payload)
       VALUES ($1,$2,$3::jsonb) ON CONFLICT (event_key) DO NOTHING RETURNING event_key`,
      [idempotencyKey,String(payload.type??"billing.event"),JSON.stringify(payload)]
    );
    return { published:result.rowCount===1,duplicate:result.rowCount===0,event_key:idempotencyKey };
  }

  async listAuditEvents(tenantId, { limit = 100, beforeId = null } = {}) {
    const result = await this.pool.query(
      `SELECT audit_id,tenant_id,actor_id,action,reason,correlation_id,target_type,target_id,payload,created_at
       FROM audit_events WHERE tenant_id=$1 AND ($2::bigint IS NULL OR audit_id<$2)
       ORDER BY audit_id DESC LIMIT $3`, [tenantId, beforeId, Math.min(500, Math.max(1, limit))]
    );
    return result.rows.map(row => ({ ...row, payload: json(row.payload) }));
  }

  async createQuotaPolicy({ tenantId, principalId = null, apiKeyId = null, period, requestLimit = null, tokenLimit = null, costLimitUusd = null, concurrencyLimit = null, actor, reason }) {
    if (!["day","month"].includes(period)) throw new Error("Quota period must be day or month.");
    for (const [name,value] of Object.entries({ requestLimit,tokenLimit,costLimitUusd,concurrencyLimit })) if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(name+" must be a non-negative integer or null.");
    const result = await this.pool.query(
      `INSERT INTO quota_policies (tenant_id,principal_id,api_key_id,period,request_limit,token_limit,cost_limit_uusd,concurrency_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING quota_id,tenant_id,principal_id,api_key_id,period,request_limit,token_limit,cost_limit_uusd,concurrency_limit,active,created_at`,
      [tenantId,principalId,apiKeyId,period,requestLimit,tokenLimit,costLimitUusd,concurrencyLimit]
    );
    await this.writeAudit({ tenantId,actorId:actor,action:"quota.created",reason,correlationId:randomUUID(),targetType:"quota",targetId:String(result.rows[0].quota_id),payload:{ principal_id:principalId,api_key_id:apiKeyId,period } });
    return result.rows[0];
  }

  async listQuotaPolicies(tenantId) {
    const result = await this.pool.query("SELECT quota_id,tenant_id,principal_id,api_key_id,period,request_limit,token_limit,cost_limit_uusd,concurrency_limit,active,created_at FROM quota_policies WHERE tenant_id=$1 ORDER BY quota_id", [tenantId]);
    return result.rows;
  }

  async deactivateQuotaPolicy({ quotaId, tenantId, actor, reason }) {
    const result = await this.pool.query("UPDATE quota_policies SET active=FALSE WHERE quota_id=$1 AND tenant_id=$2 AND active=TRUE RETURNING quota_id", [quotaId,tenantId]);
    if (result.rowCount) await this.writeAudit({ tenantId,actorId:actor,action:"quota.deactivated",reason,correlationId:randomUUID(),targetType:"quota",targetId:String(quotaId) });
    return result.rowCount === 1;
  }

  async createPricingVersion({ provider, model, region, unit, inputUsdPerMillion = 0, outputUsdPerMillion = 0, fixedUsdPerUnit = 0, version, effectiveAt, effectiveUntil = null, actor, reason }) {
    const result = await this.pool.query(
      `INSERT INTO provider_pricing_versions (provider,model,region,unit,input_usd_per_million,output_usd_per_million,fixed_usd_per_unit,version,effective_at,effective_until,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING pricing_id,provider,model,region,unit,input_usd_per_million,output_usd_per_million,fixed_usd_per_unit,version,effective_at,effective_until,created_by,created_at`,
      [provider,model,region,unit,inputUsdPerMillion,outputUsdPerMillion,fixedUsdPerUnit,version,effectiveAt,effectiveUntil,actor]
    );
    await this.writeAudit({ tenantId:null,actorId:actor,action:"pricing.version_created",reason,correlationId:randomUUID(),targetType:"pricing_version",targetId:String(result.rows[0].pricing_id),payload:{ provider,model,region,version } });
    return result.rows[0];
  }

  async listPricingVersions() {
    const result = await this.pool.query("SELECT pricing_id,provider,model,region,unit,input_usd_per_million,output_usd_per_million,fixed_usd_per_unit,version,effective_at,effective_until,created_by,created_at FROM provider_pricing_versions ORDER BY provider,model,region,effective_at DESC");
    return result.rows;
  }

  async findPricing({ provider, model, region = "global", at = new Date() }) {
    const result = await this.pool.query(
      `SELECT pricing_id,provider,model,region,unit,input_usd_per_million,output_usd_per_million,fixed_usd_per_unit,version,effective_at,effective_until
       FROM provider_pricing_versions WHERE provider=$1 AND model=$2 AND region IN ($3,'global')
       AND effective_at <= $4 AND (effective_until IS NULL OR effective_until > $4)
       ORDER BY (region=$3) DESC,effective_at DESC LIMIT 1`, [provider,model,region,at]
    );
    return result.rows[0] ?? null;
  }

  async listReconciliationJobs(tenantId) {
    const [jobs,dead] = await Promise.all([
      this.pool.query("SELECT j.*,r.request_id,r.quote_uusd,r.state AS reservation_state FROM reconciliation_jobs j JOIN reservations r USING(reservation_id) WHERE j.tenant_id=$1 ORDER BY j.created_at DESC LIMIT 500", [tenantId]),
      this.pool.query("SELECT * FROM reconciliation_dead_letters WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500", [tenantId])
    ]);
    return { jobs:jobs.rows,dead_letters:dead.rows };
  }

  async listTenants() {
    const result = await this.pool.query("SELECT tenant_id,name,monthly_limit_uusd,active,created_at FROM tenants ORDER BY created_at DESC");
    return result.rows;
  }

  async createTenant({ tenantId, name, monthlyLimitUusd, actor, reason }) {
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO tenants (tenant_id,name,monthly_limit_uusd) VALUES ($1,$2,$3)", [tenantId,name,monthlyLimitUusd]);
      await client.query("INSERT INTO audit_events (actor_id,action,reason,correlation_id,target_type,target_id,payload) VALUES ($1,'tenant.created',$2,$3,'tenant',$4,$5::jsonb)", [actor,reason,randomUUID(),tenantId,JSON.stringify({ monthly_limit_uusd:monthlyLimitUusd })]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(()=>{}); throw error; }
    finally { client.release(); }
    return { tenant_id:tenantId,name,monthly_limit_uusd:monthlyLimitUusd,active:true };
  }
}
