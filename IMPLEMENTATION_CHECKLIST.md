# Backend implementation checklist

The [verification report](VERIFICATION.md) records the latest checks for this snapshot. The counts below record the initial backend milestone.

## Implemented and exercised locally

| Area | Implementation and verification |
| --- | --- |
| API and lifecycle | FastAPI application factory, gated model discovery and usage, JSON chat and SSE, bounded input and output, request IDs, schema and error handling. |
| PostgreSQL and Alembic | Normalized catalog, policy targets and edges, tenant identities and roles, pricing, requests, attempts, ledger, and audit tables. Initial migration provisions constrained group roles, forced RLS and narrow lookup and recovery routines. |
| Authentication and tenant isolation | High-entropy keys, environment-bound HMAC digests, separate peppers, scopes, expiry and revocation. Tests cover two tenants, pooled connections, cross-tenant headers and cursors, and denied digest reads. OIDC policy write uses validated access tokens and optimistic revision checks. |
| Providers | Deterministic mock verified offline. OpenAI and Anthropic HTTP adapters exercised against protocol fixtures, including Unicode SSE frames, cumulative usage and upstream errors. |
| Deterministic routing | Capability, region, quality, pricing, hard-cap and latency checks, integer scoring, deterministic weighted selection, health signals and explicit fallback edges. |
| Distributed reliability | Redis token buckets, concurrency leases, quota cooldowns, generation-fenced half-open probes, bounded retries, backpressure and deadlines. Tests cover competing clients sharing Redis, committed stream failure, downstream disconnect and dependency failure. |
| Accounting and recovery | Reserve before dispatch, pin pricing, release proven-unsent holds, retain ambiguous exposure, and account for each attempt. Tests cover 100 competing near-cap authorizations, combined fallback spend, month rollover, worker recovery and idempotent correction. |
| Telemetry | OpenTelemetry spans and optional OTLP export, JSON correlation, bounded-label Prometheus registry, separate collector credential. In-memory trace tests verify correlation and prompt and key redaction. |
| Developer setup | Dockerfile, Compose stack, environment template, frozen dependency locks, role bootstrap and provisioning CLI. README documents the offline path, test commands and credential boundaries. |

## Initial backend verification

- **48 passed** on Python 3.12.14 and 3.13.5, using locked dependencies, PostgreSQL 17.11, and Redis 7.0.15. Alembic upgrade and schema comparison, Ruff lint, and Ruff format checks passed.
- The mock passed a real loopback Uvicorn socket smoke test on both Python versions. The smoke covered key authentication, model listing, JSON, SSE termination, and persisted usage with an empty provider credential map. Provider protocol fixtures covered both external adapters.
- Docker Compose configuration validation passed for all profiles. The role bootstrap passed shell syntax checks. Container image builds and the Compose runtime remain unverified because a Docker daemon was unavailable.

## Untested against live or managed services

- OpenAI and Anthropic live model, billing and capability verification requires dedicated sandbox credentials and an approved spend budget.
- A managed IdP, production TLS, hosted secrets, collector delivery, load balancer behavior, multi-AZ failover and regional recovery need staging verification.
- The blueprint’s production throughput, latency, availability, and soak targets require measured evidence. Local correctness checks do not certify those targets.

## Remaining scope and trade-offs

- Real providers are deliberately eligible for explicitly uncapped tenants only. Hard-budget use requires certified upper-bound evidence for each exact model, pricing and credential profile.
- Usage reads current indexed PostgreSQL projections for bounded date ranges. Scheduled rollups, retention, and analytics isolation are capacity work before larger deployments.
- Reconciliation uses bounded candidate discovery and per-period row locks. Workers can discover the same candidate. State checks and immutable ledger keys make concurrent effects idempotent.
- This release targets one Redis primary. Cluster sharding needs script key layout changes. Failover can affect transient quotas and leases.
- Metrics use a separate application bearer credential. Production ownership of the private listener and edge route restrictions belongs in the deployment rollout.
- Dashboard-facing policy administration is implemented. Supplementary dashboard and operator HTTP endpoints, the frontend, and hosted release workflows remain separate.
