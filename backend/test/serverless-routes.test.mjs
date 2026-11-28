import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rootHandler = require("../../api/[...path].js");

test("Vercel API paths share the gateway request handler", async () => {
  assert.equal(typeof rootHandler, "function");
  assert.equal(require("../../api/v1/usage.js"), rootHandler);
  assert.equal(require("../../api/v1/chat/completions.js"), rootHandler);
  assert.equal(require("../../api/v1/admin/[...path].js"), rootHandler);
});

const manualWorkerHandler = require("../../api/workers.js");
const cronWorkerHandler = require("../../api/workers/cron.js");
function captureResponse() {
  return {
    status: 0, headers: {}, body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body ?? ""; }
  };
}

test("manual worker route requires its server token before connecting", async () => {
  const original = process.env.AEGIS_WORKER_TOKEN;
  process.env.AEGIS_WORKER_TOKEN = "unit-test-only-worker-token";
  const response = captureResponse();
  try {
    await manualWorkerHandler({ method: "POST", headers: {} }, response);
    assert.equal(response.status, 401);
    assert.equal(JSON.parse(response.body).error, "unauthorized");
  } finally {
    if (original === undefined) delete process.env.AEGIS_WORKER_TOKEN;
    else process.env.AEGIS_WORKER_TOKEN = original;
  }
});

test("cron worker route requires CRON_SECRET before connecting", async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "unit-test-only-cron-token";
  const response = captureResponse();
  try {
    await cronWorkerHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.status, 401);
    assert.equal(JSON.parse(response.body).error, "unauthorized");
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});
