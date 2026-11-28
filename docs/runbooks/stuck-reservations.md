# Runbook: Stuck reservations and reconciliation backlog

1. Inspect the Grafana reconciliation backlog and oldest age. Use the tenant-scoped admin reconciliation endpoint or read-only database query; do not edit rows directly.
2. Check worker health, database connectivity, and `gateway_workers_batch` outcome counts. Restarting a worker is safe because work claims expire and settlement is idempotent.
3. For OpenAI Responses, confirm the stored response ID and route snapshot, then allow the worker to query provider usage. For Chat Completions and Anthropic Messages, inspect provider account usage logs.
4. Settle only when usage is confirmed, or release only when the provider confirms it did not execute. Otherwise preserve the reservation.
5. For dead letters, open **Administration → Reconciliation** as a tenant owner or administrator with `control:write`. Confirm the provider receipt in the provider's authoritative usage records, then record only its safe reference ID, provider request ID, token counts, calculated cost, and a reason. The resolution updates usage, the budget projection, quota windows, ledger/outbox events, dead-letter state, and audit history in one transaction.
6. Choose **Provider confirms no execution** only when provider records establish that no call ran. This releases the reservation and concurrency quota atomically. Do not use it to clear uncertainty.
7. Never paste prompts, API keys, full provider responses, or URLs containing query-string credentials into the evidence reference.
8. Escalate backlog age over the agreed SLO. Keep new admissions fail-closed if the database cannot safely reserve budget.
