import { parseApiKey, verifyApiKey } from "./api-keys.js";

export function localDemoCredentialsFromEnv(env = process.env) {
  return new Map([
    [env.AEGIS_DEMO_ASTER_TOKEN, "tenant_demo_aster"],
    [env.AEGIS_DEMO_JUNIPER_TOKEN, "tenant_demo_juniper"],
    [env.AEGIS_DEMO_BUDGET_TOKEN, "tenant_demo_budget"]
  ].filter(([token]) => typeof token === "string" && token.length > 0));
}

export function createAuthenticator({ mode = "disabled", credentials, store, keyPepper } = {}) {
  const allowed = new Map();
  if ((mode === "local" || mode === "test" || mode === "production") && credentials) {
    for (const [token, tenantId] of credentials) allowed.set(token, tenantId);
  }
  return {
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
        return { tenantId: key.tenant_id, userId: key.user_id, keyId: key.key_id, role: key.role, scopes: key.scopes };
      }
      if (mode !== "local" && mode !== "test") return null;
      const tenantId = allowed.get(match[1]);
      return tenantId ? { tenantId, role: "owner", scopes: ["admin", "gateway:invoke", "usage:read"] } : null;
    }
  };
}
