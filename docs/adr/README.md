# Architecture decision records

These decisions describe the implementation in this snapshot. The [architecture](../architecture.md) shows how they fit together. The [blueprint](../../BLUEPRINT.md) records the original targets and deferred options.

| Record | Decision |
| --- | --- |
| [ADR 001](001-state-ownership.md) | Modular gateway with Redis admission and a PostgreSQL ledger |
| [ADR 002](002-routing.md) | Deterministic policy scoring with explicit fallback edges |
| [ADR 003](003-streaming.md) | One-way stream commitment and bounded recovery |
| [ADR 004](004-spend-ledger.md) | Authorize and settle spend for each attempt |
| [ADR 005](005-tenant-isolation.md) | Scoped identities plus database-enforced tenant isolation |
