# ADR 0006: Transactional outbox for integration events

- Status: Accepted
- Date: 2026-11-27

## Decision

Write ledger mutations and outbox rows in the same PostgreSQL transaction. A worker claims rows, retries with idempotency keys, and records dead letters.

## Current boundary

The current worker materializes events in the internal `integration_events` table. It does not yet publish to a hosted queue or customer webhook. Configure an external, idempotent consumer before treating the outbox as an integration delivery guarantee.
