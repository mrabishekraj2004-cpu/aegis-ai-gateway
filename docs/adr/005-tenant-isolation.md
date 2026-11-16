# ADR 005 · Tenant isolation

**Context.** API clients, browser operators and infrastructure workers need different permissions while sharing a database and gateway.

**Alternatives.** Application-only filtering is simple but can miss a SQL path. Separate databases isolate more strongly at greater migration and operational cost. An unscoped administrative API key would centralize trust in one bearer credential.

**Decision.** Use scoped HMAC-protected service keys, validated RS256 tokens and current tenant membership for operator-facing policy endpoints, separate database roles, and forced RLS with transaction-local tenant identity. Keep provider credentials on the gateway and isolate collector access.

**Trade-offs and consequences.** Access can be denied at both the API and persistence layers. Role and scope checks add database work. Operator administration uses a separate login and narrow commands. Cursor signatures bind a page to its tenant and filters.

**Limitations.** A compromised platform secret store or privileged database account remains in the trust boundary. Managed issuer configuration, production key rotation and identity recovery require deployment-specific testing.
