# ADR 004 · Per-attempt spend

**Context.** Monthly spend cannot be enforced by counting completed requests. Concurrent attempts may reserve funds simultaneously, and provider failures can leave billing uncertain.

**Alternatives.** Post-hoc accounting simplifies dispatch but cannot enforce a cap. Approximate Redis counters are fast but cannot serve as durable spending authority. Distributed escrow could reduce hot-period locking while complicating transfers and recovery.

**Decision.** Before provider I/O, verify authorization in a short transaction, lock the tenant/month period, pin the pricing revision, and commit an attempt hold. Settle reported usage against pinned rates, release confirmed nonbillable exposure, and retain ambiguous holds for the worker and audited adjustments.

**Trade-offs and consequences.** Concurrent admission cannot spend the same budget twice within the certified bounds. Immutable ledger deltas support reconciliation and preserve the original period. A hot tenant can contend on its period lock. Estimation and pending holds can temporarily reduce usable budget.

**Limitations.** Hard caps require a certified provider bound. The mock is the certified offline case. External invoices and premium units require qualification, and large reporting workloads may require rollups.
