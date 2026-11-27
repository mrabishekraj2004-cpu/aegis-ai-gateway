export function localDemoCredentialsFromEnv(env = process.env) {
  return new Map([
    [env.AEGIS_DEMO_ASTER_TOKEN, "tenant_demo_aster"],
    [env.AEGIS_DEMO_JUNIPER_TOKEN, "tenant_demo_juniper"],
    [env.AEGIS_DEMO_BUDGET_TOKEN, "tenant_demo_budget"]
  ].filter(([token]) => typeof token === "string" && token.length > 0));
}

export function createAuthenticator({ mode = "disabled", credentials } = {}) {
  const allowed = new Map();
  if ((mode === "local" || mode === "test" || mode === "production") && credentials) {
    for (const [token, tenantId] of credentials) allowed.set(token, tenantId);
  }
  return {
    authenticate(headers = {}) {
      const value = headers.authorization ?? headers.Authorization ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(value);
      if (!match) return null;
      const tenantId = allowed.get(match[1]);
      return tenantId ? { tenantId } : null;
    }
  };
}
