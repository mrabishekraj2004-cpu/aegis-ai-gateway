const { timingSafeEqual } = require("node:crypto");
function matchesToken(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "method_not_allowed" });
    return;
  }
  const expected = process.env.AEGIS_WORKER_TOKEN;
  if (!expected) {
    response.status(503).json({ error: "worker_not_configured" });
    return;
  }
  const header = request.headers.authorization || "";
  const provided = header.replace(/^Bearer\s+/i, "");
  if (!matchesToken(provided, expected)) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const { runWorkerBatch } = await import("../backend/src/serverless-runtime.js");
    const result = await runWorkerBatch();
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      reconciliation: { claimed: result.reconciliation.claimed, outcomes: result.reconciliation.results.map(item => item.outcome) },
      outbox: { claimed: result.outbox.claimed, outcomes: result.outbox.results.map(item => item.outcome) }
    });
  } catch {
    response.status(500).json({ error: "worker_batch_failed" });
  }
};
