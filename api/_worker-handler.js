const { timingSafeEqual } = require("node:crypto");

function hasValidBearer(request, expected) {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const authorization = request.headers?.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice(7));
  const required = Buffer.from(expected);
  return provided.length === required.length && timingSafeEqual(provided, required);
}

function respond(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  response.end(JSON.stringify(body));
}

async function runBatch(response) {
  try {
    const { runWorkerBatch } = await import("../backend/src/serverless-runtime.js");
    const result = await runWorkerBatch();
    respond(response, 200, { ok: true, ...result });
  } catch (error) {
    respond(response, 500, { ok: false, error: "worker_failed" });
  }
}

async function manual(request, response) {
  if (request.method !== "POST") {
    return respond(response, 405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
  }
  if (!hasValidBearer(request, process.env.AEGIS_WORKER_TOKEN)) {
    return respond(response, 401, { ok: false, error: "unauthorized" });
  }
  return runBatch(response);
}

async function cron(request, response) {
  if (request.method !== "GET") {
    return respond(response, 405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
  }
  if (!hasValidBearer(request, process.env.CRON_SECRET)) {
    return respond(response, 401, { ok: false, error: "unauthorized" });
  }
  return runBatch(response);
}

module.exports = { manual, cron };
