# Guarded live provider compatibility check

The manual provider-compat command sends one short, non-streaming request through Aegis to OpenAI and one to Anthropic. It verifies the selected provider route, settled usage, and ledger entry. It does not retry. The prompt is synthetic and contains no customer data.

## Guardrails

- Use an HTTPS staging API or loopback URL, two test-environment Aegis keys prefixed with aegis_test_, and distinct aliases already routed to OpenAI and Anthropic.
- Use two separate synthetic tenants, one per provider. Each tenant must have a hard cap at or below the configured maximum, which cannot exceed 340000 uUSD ($0.34). Leave both tenants with positive budget and no other active requests.
- Preflight verifies both tenants and their caps before sending either provider request.
- Keep provider keys in the backend secret manager. The script sends only the test-environment Aegis keys and never prints them.
- Each request uses max_tokens 8. The gateway enforces admission against each tenant budget; a denied request is a safe stop. The script verifies the response route and the matching settled usage entry.
- Do not run against customer tenants or production Aegis keys.

Supply variables from an approved secret manager or secret-enabled CI context. Do not put values in a checked-in file or shell history:

| Variable | Purpose |
| --- | --- |
| AEGIS_LIVE_PROVIDER_TEST_CONFIRM | Set to yes after verifying the isolated test tenants and caps. |
| AEGIS_LIVE_PROVIDER_TEST_API_URL | Staging gateway origin or loopback origin. |
| AEGIS_LIVE_PROVIDER_TEST_MAX_UUSD | Integer per-tenant cap from 1 through 340000. |
| AEGIS_LIVE_OPENAI_ALIAS | Published routing alias that resolves to OpenAI. |
| AEGIS_LIVE_OPENAI_TEST_KEY | Test-environment gateway key for the capped OpenAI tenant. |
| AEGIS_LIVE_ANTHROPIC_ALIAS | Published routing alias that resolves to Anthropic. |
| AEGIS_LIVE_ANTHROPIC_TEST_KEY | Test-environment gateway key for the capped Anthropic tenant. |

From backend/, run npm run provider-compat.

The output prints provider, alias, request ID, settled micro-dollar cost, tenant cap, and ledger verification status. It never prints keys or prompts. A failed check exits without retry.

## Current result

Not run. No OpenAI/Anthropic provider secrets or staging gateway credentials are configured in the workspace. The result remains pending until run in an approved secret-enabled runner.