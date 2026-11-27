# ADR 0004: Redis is deferred

- Status: Accepted
- Date: 2026-11-27

## Decision

Do not add Redis to the first modular-monolith deployment. PostgreSQL remains authoritative for budgets, quotas, idempotency, work claims, and integration events.

## Rationale

Adding Redis before measured contention would add another failure mode and create ambiguity about which store admits spend. Database-backed atomic admission is easier to audit and test across independent connections.

## Revisit when

Benchmarks show that PostgreSQL cannot meet the agreed overhead SLO after query/index/pool tuning. Any future Redis design must explain failover consistency and prove it cannot approve budget from stale state.
