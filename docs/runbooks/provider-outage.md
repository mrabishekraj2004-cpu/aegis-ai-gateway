# Runbook: Provider outage or elevated errors

1. Check Grafana panels for provider latency, errors, circuit state, and budget denials. Identify one provider/model and the first affected time.
2. Check provider status and account quota from the provider's trusted console. Do not paste keys or prompts into tickets.
3. If an alternate route is configured and priced within the active cap, confirm its health and policy. Do not enable a route that might duplicate a request with an unknown execution outcome.
4. Keep uncertain reservations pending. The worker may settle only from an authoritative provider receipt; otherwise allow retries to the dead-letter queue.
5. If spend risk remains, disable the affected route through a reviewed, reasoned routing configuration change or lower the tenant cap. Record actor, reason, and request IDs.
6. Restore normal traffic after provider health is stable. Compare provider usage logs against gateway settlements and document mismatches.
