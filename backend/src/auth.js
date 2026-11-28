// @ts-check
import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { parseApiKey, verifyApiKey } from "./api-keys.js";

/** @param {Record<string, string | undefined>} env */
export function localDemoCredentialsFromEnv(env = process.env) {
  return new Map(/** @type {Array<[string, string]>} */([
    [env.AEGIS_DEMO_ASTER_TOKEN, "tenant_demo_aster"],
    [env.AEGIS_DEMO_JUNIPER_TOKEN, "tenant_demo_juniper"],
    [env.AEGIS_DEMO_BUDGET_TOKEN, "tenant_demo_budget"]
  ].filter(([token]) => typeof token === "string" && token.length > 0)));
}

/** @param {import("./contracts.js").AuthenticatorOptions} options */
export function createAuthenticator({ mode = "disabled", credentials, store, keyPepper, platformAdminUserIds = process.env.AEGIS_PLATFORM_ADMIN_USER_IDS, neonAuthJwksUrl = process.env.NEON_AUTH_JWKS_URL, neonAuthUrl = process.env.NEON_AUTH_URL, sessionKeySet = null } = {}) {
  const allowed = new Map();
  const platformAdmins = new Set((Array.isArray(platformAdminUserIds) ? platformAdminUserIds : String(platformAdminUserIds ?? "").split(","))
    .map(value => String(value).trim()).filter(Boolean));
  /** @type {import("jose").JWTVerifyGetKey | null} */
  let jwks = sessionKeySet;
  let issuer = null;
  if (neonAuthUrl) { try { issuer = new URL(neonAuthUrl).origin; } catch { issuer = null; } }
  if (!jwks && neonAuthJwksUrl && neonAuthUrl) {
    try { jwks = createRemoteJWKSet(new URL(neonAuthJwksUrl)); }
    catch { jwks = null; issuer = null; }
  }
  if ((mode === "local" || mode === "test" || mode === "production") && credentials) {
    for (const [token, tenantId] of credentials) allowed.set(token, tenantId);
  }
  return {
    /** @param {import("./contracts.js").AuthHeaders} headers */
    async authenticate(headers = {}) {
      const value = headers.authorization ?? headers.Authorization ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(value);
      if (!match) return null;
      const parsed = parseApiKey(match[1]);
      if (parsed && store?.authenticateApiKey && keyPepper) {
        const key = await store.authenticateApiKey(parsed.keyId);
        if (!key || key.environment !== parsed.environment || key.revoked_at || (key.expires_at && Date.parse(key.expires_at) <= Date.now())) return null;
        if (!verifyApiKey(match[1], key.key_hash, keyPepper)) return null;
        await store.touchApiKey(parsed.keyId);
        return { tenantId: key.tenant_id, userId: key.user_id, keyId: key.key_id, role: key.role, scopes: key.scopes, platformAdmin: platformAdmins.has(key.user_id) };
      }
      if (mode === "production" && jwks && issuer && store?.resolveNeonAuthUser) {
        try {
          const { payload } = await jwtVerify(match[1], jwks, { issuer });
          if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" || !payload.email) return null;
          const requestedTenant = headers["x-aegis-tenant-id"] ?? headers["X-Aegis-Tenant-ID"];
          if (requestedTenant !== undefined && (typeof requestedTenant !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(requestedTenant))) return null;
          const identity = await store.resolveNeonAuthUser({
            userId: payload.sub,
            email: payload.email,
            displayName: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : payload.email.split("@")[0],
            tenantId: requestedTenant ?? null,
            starterLimitUusd: Number(process.env.AEGIS_STARTER_MONTHLY_LIMIT_UUSD ?? 340000)
          });
          if (!identity) return null;
          const scopes = identity.role === "owner" || identity.role === "admin"
            ? ["admin", "gateway:invoke", "usage:read", "control:write"]
            : identity.role === "viewer" ? ["usage:read"] : ["gateway:invoke", "usage:read"];
          return { tenantId: identity.tenant_id, userId: payload.sub, role: identity.role, scopes, platformAdmin: platformAdmins.has(payload.sub) };
        } catch { return null; }
      }
      if (mode !== "local" && mode !== "test") return null;
      const tenantId = allowed.get(match[1]);
      return tenantId ? { tenantId, role: "owner", scopes: ["admin", "gateway:invoke", "usage:read"], platformAdmin: false } : null;
    }
  };
}
