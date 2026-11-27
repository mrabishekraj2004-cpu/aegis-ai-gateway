# Service Objectives and Capacity Plan

These are initial operating objectives for a single-region deployment, not measured production guarantees. The service must publish real measurements before these targets are treated as contractual SLOs.

| Objective | Initial target | Measurement / response |
| --- | --- | --- |
| Successful gateway availability | 99.9% per calendar month, excluding customer-invalid requests and provider failures | `aegis_gateway_responses_total`; alert on sustained 5xx ratio. |
| Gateway-only overhead | p95 below 100 ms over 5 minutes, excluding model-provider time | `aegis_gateway_overhead_ms`; alert and inspect database pool/lock waits. |
| Budget correctness | 100%: no provider invocation without an admitted reservation; no duplicate settlement | PostgreSQL admission, ledger, and idempotency invariants; any violation is an incident. |
| Reconciliation freshness | 99% of resolvable records leave pending within 5 minutes | Backlog count and oldest age; provider lookup capability varies by adapter. |
| Outbox freshness | 99% of internal outbox records are processed within 2 minutes | `aegis_outbox_backlog`; delivery only means written to the current integration-events store until an external consumer exists. |

## Initial sizing assumptions

- PostgreSQL is the single budget authority. There is no multi-region write mode; do not fail open or accept budget writes against a stale replica.
- Start with 2 API instances, 1 worker instance, PostgreSQL sized for 4-8 vCPU and 16-32 GiB RAM, 100 application connections maximum across all replicas, and 100 GiB database storage with monitored growth. These are conservative staging starting points, not benchmark-backed production capacity.
- Keep provider concurrency limits below provider account quotas. Scale workers only after measuring locked-row age, DB pool utilization, and provider rate limits.
- Prometheus retention defaults to 15 days locally. Hosted retention, trace sampling, database retention/partitioning, and per-tenant fairness remain deployment choices.

Before production, run a repeatable baseline at 1x expected peak and a 2x burst for at least 30 minutes; record request rate, p50/p95/p99 overhead, error rate, Postgres CPU/IO, lock waits, pool wait, worker backlog, and provider throttles. Repeat crash injection at reservation, during provider execution, after provider success, and before settlement. No capacity result is published yet because the Docker engine is unavailable in this workspace.
