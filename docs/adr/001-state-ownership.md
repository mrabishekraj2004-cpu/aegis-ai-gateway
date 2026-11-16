# ADR 001 · State ownership

**Context.** Replicas must share admission and respect a tenant's changing policy and spending balance. A single process may terminate mid-request.

**Alternatives.** A process-local limiter is straightforward and avoids network calls. A PostgreSQL-only design can serialize all state under one database, including high-frequency quotas. Independent gateway, routing and accounting services allow independent releases at the cost of distributed RPC and coordination.

**Decision.** Use a modular asynchronous gateway with a separate reconciliation process. Keep durable policy, identity and ledger state in PostgreSQL. Use Redis scripts and leases for transient counters, provider health and admission.

**Trade-offs and consequences.** The gateway can scale horizontally while preserving shared quotas on a healthy primary. Critical spend operations still contend on a tenant's period row. Redis loss blocks new inference rather than relaxing limits. Spend holds survive process loss and can be reconciled independently.

**Limitations.** The current Redis scripts assume one writable primary. Failover can regress recent ephemeral writes. Managed promotion, cluster sharding and sustained throughput are unverified. Evaluate sharding or spend escrow only after contention measurements justify the additional consistency model.
