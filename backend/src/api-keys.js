import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const scopes = new Set(["gateway:invoke", "usage:read", "keys:manage", "control:read", "control:write", "admin"]);
const keyPattern = /^aegis_(live|test)_([a-zA-Z0-9_-]{12,40})\.([A-Za-z0-9_-]{32,})$/;

export function hashApiKey(value, pepper) {
  if (typeof pepper !== "string" || pepper.length < 32) throw new Error("AEGIS_KEY_PEPPER must contain at least 32 characters.");
  return createHmac("sha256", pepper).update(value).digest("hex");
}

export function createApiKeyMaterial({ environment = "live", pepper, now = new Date() } = {}) {
  if (!new Set(["live", "test"]).has(environment)) throw new Error("API key environment must be live or test.");
  const id = randomBytes(12).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const value = `aegis_${environment}_${id}.${secret}`;
  return {
    value,
    record: {
      key_id: id,
      key_prefix: `aegis_${environment}_${id}`,
      key_hash: hashApiKey(value, pepper),
      environment,
      created_at: now.toISOString()
    }
  };
}

export function parseApiKey(value) {
  if (typeof value !== "string") return null;
  const match = keyPattern.exec(value);
  return match ? { environment: match[1], keyId: match[2] } : null;
}

export function verifyApiKey(value, expectedHash, pepper) {
  if (!parseApiKey(value) || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(hashApiKey(value, pepper), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validateScopes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some(scope => !scopes.has(scope))) {
    throw new Error("API key scopes must be a non-empty array of supported scopes.");
  }
  return [...new Set(value)].sort();
}

export class ApiKeyService {
  constructor({ store, pepper, clock = () => new Date() } = {}) {
    if (!store) throw new Error("ApiKeyService requires a store.");
    if (typeof pepper !== "string" || pepper.length < 32) throw new Error("AEGIS_KEY_PEPPER must contain at least 32 characters.");
    this.store = store;
    this.pepper = pepper;
    this.clock = clock;
  }

  async create({ tenantId, userId, name, scopes: requestedScopes, expiresAt, createdBy, reason = "API key created", environment = "live" }) {
    if (!tenantId || !userId || !name?.trim()) throw new Error("Tenant, member, and key name are required.");
    const normalizedScopes = validateScopes(requestedScopes);
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.clock().getTime())) {
      throw new Error("API key expiration must be a future timestamp.");
    }
    const material = createApiKeyMaterial({ environment, pepper: this.pepper, now: this.clock() });
    await this.store.createApiKey({
      ...material.record, tenantId, userId, name: name.trim(), scopes: normalizedScopes,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, createdBy, reason
    });
    return { key: material.value, id: material.record.key_id, prefix: material.record.key_prefix, tenant_id: tenantId, user_id: userId, scopes: normalizedScopes, expires_at: expiresAt ?? null };
  }

  async rotate({ keyId, tenantId, actor, reason = "Key rotation" }) {
    const old = await this.store.getApiKey(keyId, tenantId);
    if (!old || old.revoked_at) throw new Error("Active API key not found.");
    const material = createApiKeyMaterial({ environment: old.environment, pepper: this.pepper, now: this.clock() });
    const rotated = await this.store.rotateApiKey({
      previousKeyId: keyId, tenantId, actor, reason, material: {
        ...material.record, userId: old.user_id, name: old.name, scopes: old.scopes, expiresAt: old.expires_at
      }
    });
    if (!rotated) throw new Error("API key was revoked before rotation completed.");
    return { key: material.value, id: material.record.key_id, prefix: material.record.key_prefix, rotated_from: keyId };
  }

  async revoke({ keyId, tenantId, actor, reason }) {
    return this.store.revokeApiKey({ keyId, tenantId, actor, reason });
  }
}
