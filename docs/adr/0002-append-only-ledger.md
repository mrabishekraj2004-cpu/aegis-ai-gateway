# ADR 0002: Append-only billing events

- Status: Accepted
- Date: 2026-11-27

## Decision

Represent reservations, provider start, reported usage, settlement, release, and adjustments as idempotent append-only ledger events. Materialized budget and usage rows are projections rebuilt or checked from those events.

## Rationale

An immutable event history makes duplicate settlement detectable and supports support/audit workflows. Billing events and the integration outbox are written in one PostgreSQL transaction.

## Consequences

Corrections add an adjustment event; operators do not edit historical cost rows. Consumers must deduplicate by stable event key. Projection rebuild and reconciliation tools remain necessary as the data volume grows.
