# ADR 002 · Routing policy

**Context.** A deployment can satisfy some model capabilities while violating a tenant's region, pricing or performance requirements. Operators need to explain a choice and reproduce it from fixed inputs.

**Alternatives.** Static priorities are easy to predict but ignore cost and observations. Lowest-cost selection alone tends to concentrate traffic. Learned routing would require representative training data, evaluation and explicit tenant controls.

**Decision.** Filter eligibility first. Rank with deterministic integer penalties and stable ties. Allow an opt-in weighted band for initial distribution. Persist a bounded routing record and apply live breaker, lease and spend admission before dispatch. Use an explicit directed fallback graph.

**Trade-offs and consequences.** Weights and constraints are reviewable in a versioned policy. A seed gives reproducible ordering for the same request and observations. Measured latency and failure rates are historical, so the gateway can see different rankings on separate replicas with different observation snapshots.

**Limitations.** Sampled traces and a top-three evidence record do not capture every candidate outcome. Catalog quality tiers and cost bounds depend on operator enrollment. The console in this snapshot edits policies but has no API for request-level explanations.
