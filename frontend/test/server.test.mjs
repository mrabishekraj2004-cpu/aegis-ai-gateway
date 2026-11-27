import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";

function responseCapture() {
  return {
    statusCode: null,
    headers: {},
    body: undefined,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

test("static request handler serves the standalone frontend and module assets", async () => {
  const server = createServer();
  const handler = server.listeners("request")[0];
  const request = async (url, method = "GET") => {
    const response = responseCapture();
    await handler({ url, method }, response);
    return response;
  };
  const [page, styles, app, missing, post] = await Promise.all([
    request("/"), request("/styles.css"), request("/src/main.js"), request("/missing.js"), request("/", "POST")
  ]);
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["Content-Type"], /text\/html/);
  assert.match(String(page.body), /Aegis Gateway/);
  assert.equal(styles.statusCode, 200);
  assert.match(styles.headers["Content-Type"], /text\/css/);
  assert.equal(app.statusCode, 200);
  assert.match(app.headers["Content-Type"], /javascript/);
  assert.equal(missing.statusCode, 404);
  assert.equal(post.statusCode, 405);
});

test("runtime config serves the API URL and exposes demo tokens only in explicit local demo mode", async () => {
  const server = createServer({ env: {
    AEGIS_API_BASE_URL: "http://127.0.0.1:4174",
    AEGIS_LOCAL_DEMO: "true",
    AEGIS_DEMO_ASTER_TOKEN: "synthetic-aster-token",
    AEGIS_DEMO_JUNIPER_TOKEN: "synthetic-juniper-token",
    AEGIS_DEMO_BUDGET_TOKEN: "synthetic-budget-token"
  } });
  const handler = server.listeners("request")[0];
  const response = responseCapture();
  await handler({ url: "/runtime-config.js", method: "GET" }, response);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["Content-Type"], /javascript/);
  const source = String(response.body);
  assert.match(source, /http:\/\/127\.0\.0\.1:4174/);
  assert.match(source, /"localDemoMode":true/);
  assert.match(source, /synthetic-budget-token/);

  const ordinary = createServer({ env: { AEGIS_API_TOKEN: "ordinary-local-token" } });
  const ordinaryResponse = responseCapture();
  await ordinary.listeners("request")[0]({ url: "/runtime-config.js", method: "GET" }, ordinaryResponse);
  assert.match(String(ordinaryResponse.body), /"demoTokens":\{\}/);
  assert.doesNotMatch(String(ordinaryResponse.body), /ordinary-local-token/);
  assert.doesNotMatch(String(ordinaryResponse.body), /accessToken/);
  assert.equal(ordinaryResponse.headers["Content-Security-Policy"]?.includes("connect-src"),true);
});
