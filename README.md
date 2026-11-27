# Aegis AI Gateway

Aegis is a tenant-aware HTTP gateway prototype for routed model requests, budget admission, settlement, and usage reporting.

## Repository layout

- `frontend/` — responsive gateway console with fixture and API modes.
- `backend/` — bearer-authenticated gateway, budget ledger, mock provider, and PostgreSQL adapter.
- `docs/` — project plan, requirements, architecture, handoffs, and verification notes.

## Run locally

Start the frontend fixture preview:

```powershell
cd frontend
npm start
```

The frontend serves on `http://127.0.0.1:4173` and starts in synthetic fixture mode.

The backend requires an explicitly configured storage adapter. See [Step 7](docs/STEP7_DATABASE_HANDOFF.md) for PostgreSQL setup and [Step 8](docs/STEP8_INTEGRATION_HANDOFF.md) for the local integration commands. The deterministic mock provider does not require a paid model key.

## Checks

```powershell
cd frontend
npm run check
npm test
```

```powershell
cd backend
npm run check
npm test
```

## Preview status

Login, registration, team, and API-key screens are frontend previews. A production identity service and user account system are not connected. Do not put credentials in browser code; configure secrets through the server environment.
