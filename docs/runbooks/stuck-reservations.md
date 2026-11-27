# Runbook: Stuck reservations and reconciliation backlog

1. Inspect the Grafana reconciliation backlog and oldest age. Use the tenant-scoped admin reconciliation endpoint or read-only database query; do not edit rows directly.
2. Check worker health, database connectivity, and `gateway_workers_batch` outcome counts. Restarting a worker is safe because work claims expire and settlement is idempotent.
3. For OpenAI Responses, confirm the stored response ID and route snapshot, then allow the worker to query provider usage. For Chat Completions and Anthropic Messages, inspect provider account usage logs.
4. Settle only when usage is confirmed, or release only when the provider confirms it did not execute. Otherwise preserve the reservation.
5. For dead letters, record the provider receipt, request ID, pricing/config version, operator, and reason. Use the reviewed reconciliation administrative action; never update a budget projection manually.
6. Escalate backlog age over the agreed SLO. Keep new admissions fail-closed if the database cannot safely reserve budget.
