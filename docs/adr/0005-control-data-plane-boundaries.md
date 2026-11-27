# ADR 0005: Control plane and data plane share a modular monolith

- Status: Accepted
- Date: 2026-11-27

## Decision

Keep control-plane routes and data-plane request execution in one deployable backend, with separate modules and authorization checks. Run the API and workers as independent processes from the same image.

## Rationale

This keeps the PostgreSQL transaction boundary local while preserving explicit boundaries around authentication, policy, reservation, routing, provider calls, settlement, administration, and asynchronous work.

## Consequences

The API and workers can scale separately but share a release version and database schema. Platform-wide mutations require an allowlisted platform-admin user identity; tenant administrators cannot cross tenant boundaries.
