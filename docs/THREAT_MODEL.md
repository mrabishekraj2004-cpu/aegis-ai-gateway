# Threat Model

## Scope and trust boundaries

The system contains an internet-facing HTTP API, an administrative control plane, tenant API keys, provider APIs, PostgreSQL as the authoritative budget ledger, background workers, a browser console, and a private telemetry network. User prompts and provider responses are sensitive and should not enter logs, metrics labels, or audit events.

| Threat | Main mitigation | Existing evidence | Remaining work |
| --- | --- | --- | --- |
| Cross-tenant reads or writes | Tenant identity comes from a hashed server-issued key; tenant-owned SQL filters by tenant; global tenant and pricing endpoints require a server-configured platform-admin identity. | Backend tests verify tenant isolation and deny tenant admins from global control-plane routes. | Add API-level fuzz/property coverage for every future route and production role review. |
| Stolen key or replay | Store only peppered key hashes; scope, expiration, revocation, last-used time, rotation; idempotency key is scoped to tenant and request hash. | API-key tests cover hash storage, scope, revocation, and idempotent requests. | Add centralized rate limits, anomaly alerts, and customer-managed IP restrictions. |
| Prompt leakage | Credentials stay server side; structured telemetry avoids prompt and response attributes; request logging is not enabled by default. | Code review and existing logging tests. | Add automated log redaction regression test and production log sink review. |
| SSRF | Provider endpoints are deployment configuration, not values accepted from request payloads or model output. | Request validation and fixed adapter endpoints. | Enforce egress allowlists at the network layer and add explicit endpoint validation for custom deployments. |
| Budget exhaustion | PostgreSQL transaction/row locking reserves applicable budget before provider invocation; quotas and small spend caps limit exposure. | PostgreSQL concurrency and budget denial tests run in CI. | Load-test lock contention and configure tenant/key request-rate limits at the edge. |
| Malicious or oversized provider result | Provider response byte limit, schema normalization, timeouts, and output token limit. | Adapter response tests. | Fuzz malformed streaming frames and validate content policy outside the gateway. |
| Log/metric leakage | Metrics use low-cardinality route/provider/status labels; provider keys are not logged; telemetry network is private in Compose. | Observability code and Compose topology. | Enforce retention/access policies in hosted log and trace backends. |
| Unknown provider outcome causes duplicate billing | Unknown outcomes never trigger failover; reservations stay pending and idempotent settlement prevents duplicate charges. OpenAI Responses can be retrieved by ID. | Worker and adapter reconciliation tests. | Anthropic Messages and OpenAI Chat Completions need provider-log/manual reconciliation; no provider lookup is exposed for these APIs. |
| Admin credential compromise | Platform admin membership is configured server-side and all mutations require an owner/admin scope plus a reason. | Authorization tests and audit write path. | Require SSO/MFA through an external identity layer before production; rotate the pepper only with a planned key reissue. |

The threat model is an engineering input, not evidence that a penetration test has been completed. See [security CI](../.github/workflows/security.yml) and the runbooks for operational responses.
