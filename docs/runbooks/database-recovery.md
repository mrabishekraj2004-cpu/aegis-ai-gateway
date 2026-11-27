# Runbook: PostgreSQL failure and recovery

## Connection or primary failure

1. New paid admissions must fail closed when PostgreSQL is unavailable. Check application pool errors, database health, storage exhaustion, and provider traffic.
2. Stop additional traffic before promoting a standby. Fence the former writer to avoid two budget authorities.
3. Recover to a single writable primary from the latest verified backup or managed failover. Do not configure independent regional writers.
4. Start with migrations, then API, then workers. Verify the schema version and inspect pending reservations/outbox events before reopening traffic.

## Restore rehearsal

1. Restore a recent backup to an isolated disposable database.
2. Run migrations and ledger projection checks; compare a sample of ledger totals with budget/usage projections.
3. Verify idempotent replay, tenant isolation, API-key verification, and worker claims.
4. Record recovery point, recovery time, missing provider receipts, and any manual reconciliation needed. Production RPO/RTO remain unset until this rehearsal has been measured.
