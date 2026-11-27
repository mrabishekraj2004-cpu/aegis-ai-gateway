# Runbook: API key compromise

1. Identify the key ID and tenant from audit records. Never copy the full key into an incident ticket or log.
2. Revoke the key through the authenticated tenant control plane and record the incident reason. For a platform administrator key, use a second platform administrator or the approved break-glass procedure.
3. Issue a replacement with the minimum required scopes and an expiration. Deliver it through the tenant's secret manager, not chat or source control.
4. Review last-used timestamps, request IDs, usage, budget reservations, and audit history for unauthorized activity. Preserve uncertain provider costs for reconciliation.
5. Rotate related provider/database credentials only if there is evidence they were exposed. Validate the replacement key and monitor denied/replayed traffic.
