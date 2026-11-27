# End-to-end demonstration recording

## Planned 3-minute capture

Use only the local Compose stack and synthetic tenants. Keep the browser and terminal free of production credentials.

1. Start with `docker compose up --build` and wait until API, workers, and PostgreSQL are healthy.
2. Open the console at `http://localhost:4173`, select **Budget Demo - $0.34 request cap**, and show the budget at `$0.34` remaining.
3. Send one short request. Show the selected route, request ID, usage row, `$0.34` settled spend, and zero remaining budget.
4. Send a second request. Show the budget denial and the unchanged usage count; the backend checks budget before invoking the provider.
5. Reset the local database only if another complete run is needed, then select the mock failure scenario. Show the pending reservation before the worker resolves the deterministic mock receipt.
6. Open Grafana and show the request/error and reconciliation panels. A fresh Prometheus scrape may take up to 15 seconds.
7. End with the README links for the threat model, operational SLOs, and runbooks.

## Recording status

No video has been recorded. The Docker engine was unavailable in the verification workspace, so the full stack and browser flow could not be launched there. Record the clip after `docker compose up --build` is available, and attach the resulting video to the GitHub repository release or its demo documentation. Do not describe this runbook as a completed recording.
