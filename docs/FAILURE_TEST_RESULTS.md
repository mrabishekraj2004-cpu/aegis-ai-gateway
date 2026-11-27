# Load, crash-recovery, and failure-injection results

## Results

| Scenario | Result | Evidence / blocker |
| --- | --- | --- |
| PostgreSQL concurrent admission across independent connections | Passed in GitHub PostgreSQL CI with zero skipped database cases. | CI starts PostgreSQL and rejects skipped integration cases. |
| Duplicate/idempotent settlement and tenant isolation | Passed in GitHub PostgreSQL CI with zero skipped database cases. | PostgreSQL integration suite. |
| Backend restart persistence | Passed in GitHub PostgreSQL CI for synthetic usage and settled spend. | Integration test closes and recreates the store connection against PostgreSQL. |
| Worker reconciliation and duplicate-safe settlement | Passed in GitHub CI. | PostgreSQL worker tests and deterministic provider tests. |
| Client disconnect during a non-stream provider call | Passed as an in-process provider cancellation test. | Provider signal aborts and the reservation remains reconcile_required. This is not a process kill. |
| Process termination after reservation, during provider execution, after provider success, before settlement | Not run. | Docker Desktop engine pipe npipe:////./pipe/dockerDesktopLinuxEngine is unavailable: The system cannot find the file specified. |
| Database outage, delayed response, duplicate provider response, network interruption | Not run as a process-level fault matrix. | Requires the unavailable Docker runtime or a dedicated fault-injection runner. Unit tests cover uncertain outcomes and duplicate-safe settlement. |
| Bounded load against deterministic mock | Guarded script added; benchmark not run. | Requires a loopback/test endpoint with only the mock provider, a test credential, and an isolated tenant hard cap. Docker runtime is unavailable here. |

## Safe mock load command

The updated backend/scripts/load.mjs refuses unapproved hosts and providers, requires explicit mock confirmation, preflights the tenant cap and full planned spend, and is limited to 20 requests and $6.80 total. It verifies each generated request ID and its $0.34 usage entry in the API ledger, then compares the ledger entries with the settled budget delta. It prints aggregate latency and spend, never the bearer key or prompt.

Set AEGIS_LOAD_API_URL, AEGIS_LOAD_TEST_KEY, AEGIS_LOAD_CONFIRM_MOCK=true, AEGIS_LOAD_MAX_SPEND_UUSD, and optionally request count and concurrency in an ignored local environment. From backend/, run npm run load-test only after confirming that health reports mock as its sole provider.

## Required staging follow-up

Capture timings and process-kill checkpoints on a disposable PostgreSQL-backed staging deployment. For every injected failure, record whether the provider was called, reservation state, usage entry, ledger balance, worker action, and whether a second provider call occurred. Use only synthetic tenants, enforce the pre-set cap, and stop if spend exceeds it.