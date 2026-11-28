import test from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAuthenticator } from "../src/auth.js";

const issuer = "https://staging-auth.example.test";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = { ...await exportJWK(publicKey), kid: "staging-test-key", alg: "RS256", use: "sig" };
const keySet = createLocalJWKSet({ keys: [publicJwk] });

async function tokenFor(overrides = {}) {
  return new SignJWT({ email: "owner@example.test", name: "Workspace Owner", ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer(issuer)
    .setSubject("auth-user-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function makeAuth(role = "owner") {
  const calls = [];
  const auth = createAuthenticator({
    mode: "production",
    neonAuthUrl: `${issuer}/aegis_staging/auth`,
    sessionKeySet: keySet,
    store: {
      authenticateApiKey: async () => null,
      touchApiKey: async () => {},
      resolveNeonAuthUser: async identity => {
        calls.push(identity);
        return { tenant_id: "tenant_staging_1", role, tenant_name: "Workspace Owner Workspace" };
      }
    }
  });
  return { auth, calls };
}

test("verified Neon Auth session maps to an owner-scoped tenant principal", async () => {
  const { auth, calls } = makeAuth("owner");
  const bearer = await tokenFor();
  const principal = await auth.authenticate({ authorization: `Bearer ${bearer}` });
  assert.equal(principal?.tenantId, "tenant_staging_1");
  assert.equal(principal?.userId, "auth-user-1");
  assert.equal(principal?.role, "owner");
  assert.ok(principal?.scopes.includes("control:write"));
  assert.equal(calls[0].email, "owner@example.test");
  assert.equal(calls[0].starterLimitUusd, 340000);
});

test("Neon Auth tenant selection must resolve through a real membership", async () => {
  const { auth, calls } = makeAuth("viewer");
  const bearer = await tokenFor();
  const principal = await auth.authenticate({ authorization: `Bearer ${bearer}`, "x-aegis-tenant-id": "tenant_staging_1" });
  assert.equal(principal?.tenantId, "tenant_staging_1");
  assert.deepEqual(principal?.scopes, ["usage:read"]);
  assert.equal(calls[0].tenantId, "tenant_staging_1");
});

test("invalid Neon Auth JWTs and malformed tenant selectors are denied", async () => {
  const { auth } = makeAuth();
  assert.equal(await auth.authenticate({ authorization: "Bearer not-a-jwt" }), null);
  const bearer = await tokenFor();
  assert.equal(await auth.authenticate({ authorization: `Bearer ${bearer}`, "x-aegis-tenant-id": "bad tenant" }), null);
});
