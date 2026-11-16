# Gateway API

Local base URL `http://127.0.0.1:8000/v1`. Managed clients should use the gateway HTTPS origin. The [quick start](../README.md#quick-start) provisions a disposable tenant and puts its API key in the current shell as `aegis_key`.

| Method and path | Access |
| --- | --- |
| `POST /v1/chat/completions` | Scoped key with `chat:write`, or OIDC member with `playground:run` |
| `GET /v1/models` | `models:read` |
| `GET /v1/usage` | `usage:read` |
| `GET /v1/admin/routing-policies` | OIDC member with `policies:read` |
| `POST /v1/admin/routing-policies` | OIDC member with `policies:write` |
| `GET /v1/health` | Public coarse readiness |
| `GET /livez` | Public process liveness |
| `GET /v1/metrics` | Dedicated collector bearer. Returns 404 if the collector token is unset |

Send `Authorization: Bearer …` for protected endpoints. OIDC clients also send the canonical lowercase tenant UUID in `X-Tenant-ID`. The backend checks membership against PostgreSQL. An API key already identifies its tenant. An optional matching tenant header is allowed. A conflicting tenant header is denied.

Every HTTP response carries a gateway-generated `X-Request-ID`. For completions, clients may additionally send `X-Client-Request-ID` containing up to 64 characters from letters, digits, period, underscore and hyphen. This value correlates requests and provides no idempotency.

## Discover models and complete a request

```bash
curl -fsS http://127.0.0.1:8000/v1/models \
  -H "Authorization: Bearer $aegis_key"

curl -fsS http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $aegis_key" \
  -H 'Content-Type: application/json' \
  -d '{"model":"mock-chat","messages":[{"role":"user","content":"Hello"}],"max_completion_tokens":5}'
```

The models response wraps the tenant's published aliases in `{"object":"list","data":[...]}`. Each entry carries `id`, `object`, `created`, and `owned_by`. A seeded tenant has `auto` and `mock-chat`.

The completion response includes a generated completion ID, a Unix creation timestamp, the requested alias, one choice, and reported usage when available. For the fixture request above, the choice has role `assistant`, five words, and finish reason `stop`. The relevant fields are shown below.

```json
{
  "object": "chat.completion",
  "model": "mock-chat",
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15
  }
}
```

The request body accepts unencoded UTF-8 JSON up to 128 KiB. It supports 1–64 text messages, each up to 64 KiB, an optional system message at the beginning, and user and assistant roles. The conversation begins and ends with a user message after the optional system message. Use only one of `max_completion_tokens` and `max_tokens`. The ceiling defaults to 256 and is capped at 2,048 before deployment-specific checks. Use at most one of `temperature` and `top_p`. Up to four stop strings are accepted when the selected model supports them. The current implementation supports `n=1`. Tools, multimodal parts, and unknown fields are rejected.

The `auto` alias accepts an `aegis.latency_class` value of `standard`, `interactive`, or `batch` where the tenant policy permits it.

## Streaming

```bash
curl -fsSN http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $aegis_key" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"max_completion_tokens":5,"stream":true,"stream_options":{"include_usage":true}}'
```

Successful SSE uses `text/event-stream`. It starts with an assistant role delta, followed by content deltas, a finish chunk, an optional usage chunk with empty `choices`, and `data: [DONE]`. Idle comments can keep the transport open. Completion usage refers to the winning attempt. The ledger can contain other attempts from the same request.

Before commitment, errors use the normal HTTP status and JSON error body. After commitment, a failure can arrive as `event: error` with the same error body if the transport is writable. EOF without `[DONE]` means the output is incomplete. The gateway does not replay a partial stream. Retrying from the client creates a new request and possible charge.

## Usage

The `from` and `to` parameters are required calendar dates in UTC. The range is half-open and limited to 93 days within the retained horizon. The latest valid `to` date is tomorrow UTC. Group by `day`, `model`, or `day_model`. Optional `model` filters an alias. Page size defaults to 50 and can be at most 100. To fetch the next page, retain the filters and send the opaque `next_cursor`.

```bash
read -r aegis_today aegis_tomorrow < <(python3 - <<'PY'
from datetime import UTC, datetime, timedelta
today = datetime.now(UTC).date()
print(today, today + timedelta(days=1))
PY
)
curl -fsSG http://127.0.0.1:8000/v1/usage \
  -H "Authorization: Bearer $aegis_key" \
  --data-urlencode "from=$aegis_today" --data-urlencode "to=$aegis_tomorrow" \
  --data-urlencode 'model=mock-chat' --data-urlencode 'group_by=model'
```

The envelope includes `object`, `data`, `as_of`, `currency`, `range`, `complete_through`, `has_more`, and `next_cursor`. A response can include a partial current day. Counters and monetary amounts are JSON strings. One successful `mock-chat` request from the example above contributes the following fields to its grouped row at the seeded synthetic rates.

```json
{
  "day": null,
  "model": "mock-chat",
  "requests": "1",
  "attempts": "1",
  "reported_attempts": "1",
  "prompt_tokens_observed": "10",
  "completion_tokens_observed": "5",
  "reported_microusd": "20",
  "pending_hold_microusd": "0",
  "total_finalized_microusd": "20"
}
```

Full rows also include estimated and adjusted amounts and counts, confirmed nonbillable attempts, pending attempts, and unknown token counts.

## Versioned policy administration

Configure `AEGIS_OIDC_ISSUER`, `AEGIS_OIDC_AUDIENCE`, and `AEGIS_OIDC_JWKS_URL` together. Use short-lived RS256 access tokens. Establish the user's verified issuer and subject membership through `aegis-admin member`. The example assumes an authorized owner established `aegis_oidc_token` and `aegis_tenant` in the shell, and that `jq` is installed. Use a disposable seeded tenant because the write creates a new policy revision.

```bash
curl -fsSG http://127.0.0.1:8000/v1/admin/routing-policies \
  -H "Authorization: Bearer $aegis_oidc_token" -H "X-Tenant-ID: $aegis_tenant" \
  --data-urlencode 'model=mock-chat' --data-urlencode 'status=active'
```

The list envelope includes `data`, `has_more`, and `next_cursor`. A row includes the alias, status, policy revision, catalog revision, targets, and active configuration. A write supplies `expected_revision`, the current catalog revision, a change reason, and valid targets with their tenant-approved regions. The following command previews a new revision that keeps the existing policy configuration.

```bash
aegis_policy_file="$(mktemp)"
curl -fsSG http://127.0.0.1:8000/v1/admin/routing-policies \
  -H "Authorization: Bearer $aegis_oidc_token" -H "X-Tenant-ID: $aegis_tenant" \
  --data-urlencode 'model=mock-chat' --data-urlencode 'status=active' |
  jq -e '.data[0] | select(. != null) | .expected_revision = .revision |
    .change_reason = "Reviewed local policy snapshot" |
    del(.id, .version_id, .created_by, .created_at, .updated_at, .revision)' > "$aegis_policy_file"
cat "$aegis_policy_file"
```

After reviewing the file, publish it. A successful response is `201 Created` with the current policy configuration and an incremented revision. A stale policy or catalog yields 409. Refresh the current revision and review the targets before trying again. Use the [OpenAPI request schemas](../frontend/contracts/openapi.json) for the active and disabled policy write shapes.

```bash
curl -fsS http://127.0.0.1:8000/v1/admin/routing-policies \
  -H "Authorization: Bearer $aegis_oidc_token" -H "X-Tenant-ID: $aegis_tenant" \
  -H 'Content-Type: application/json' --data-binary "@$aegis_policy_file"
rm -f "$aegis_policy_file"
```

## Errors and throttling

JSON failures use `error.message`, `error.type`, `error.param`, `error.code`, and the gateway `request_id`. For example, a missing key returns HTTP 401 with this shape. The request ID shown is illustrative.

```json
{
  "error": {
    "message": "A bearer credential is required.",
    "type": "authentication_error",
    "param": null,
    "code": "authentication_required"
  },
  "request_id": "00000000-0000-4000-8000-000000000000"
}
```

| Status | Representative codes |
| --- | --- |
| 400 | `invalid_request`, `unsupported_parameter`, `invalid_cursor`, `context_length_exceeded` |
| 401 / 403 | `authentication_required`, `invalid_api_key`, `invalid_access_token`, `tenant_forbidden`, `insufficient_scope`, `request_cost_limit_exceeded` |
| 404 | `model_not_found`, `resource_not_found` |
| 409 / 410 | `policy_version_conflict`, `policy_catalog_conflict`, `cursor_expired` |
| 413 / 415 | `request_too_large`, `unsupported_media_type` |
| 429 | `rate_limit_exceeded`, `concurrency_limit_exceeded`, `budget_exceeded` |
| 502 / 503 / 504 | `provider_error`, `provider_protocol_error`, `provider_overloaded`, `no_healthy_route`, `admission_unavailable`, `accounting_unavailable`, `provider_timeout`, `request_timeout` |

For inference, Redis enforces 120 tenant requests per minute with a 30-request burst and 60 principal requests per minute with a 15-request burst. Separate tenant and principal prompt-unit buckets refill at 120,000 and 60,000 per minute with bursts of 32,000 and 20,000. Cold buckets start at one quarter of the burst. The principal is the specific key or OIDC user. The gateway charges quota before model lookup, so an authenticated, syntactically valid request to an unknown alias consumes quota. When the gateway can calculate when credit returns, `Retry-After` provides seconds until retry. A period-budget denial has separate accounting semantics.

`GET /v1/health` returns coarse `ok` or `unavailable` status with a request ID. `GET /livez` returns a plain-text process response. Keep `/v1/metrics` on an operator-only path.

The live schema is at `/openapi.json`. Swagger UI is available at `/docs` in local and test environments. The [checked-in generated schema](../frontend/contracts/openapi.json) supports the console's generated types. SSE framing and policy response fields are also described here because the generated schema covers those surfaces only in part.
