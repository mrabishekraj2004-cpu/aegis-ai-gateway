# ADR 0001: PostgreSQL is the budget authority

- Status: Accepted
- Date: 2026-11-27

## Decision

Use PostgreSQL transactions and row locks for request admission and settlement. Budget decisions must be strongly consistent within one home region. Redis may later cache non-authoritative data, but it may not independently approve spend.

## Rationale

The gateway must reserve budget before calling a provider and prevent concurrent requests from overspending. PostgreSQL already stores tenants, reservations, idempotency, ledger events, and outbox records in one transactional boundary. A partition or failed database therefore rejects new paid requests instead of risking double spend.

## Consequences

Database latency and lock contention constrain admission throughput. Monitor pool wait, transaction duration, deadlocks, and lock age. Regional failover requires a single promoted writer and a fenced old primary; asynchronous multi-region writers are not supported.
