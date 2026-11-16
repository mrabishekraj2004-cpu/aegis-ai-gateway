# Local development

## Compose

Follow the [README setup](../README.md#quick-start) to generate an ignored `.env`, migrate, and start the stack. The checked-in [.env.example](../.env.example) enumerates its inputs. The generated passwords are URL-safe for Compose's connection strings. The admin and migration connections are separate from gateway and worker connections.

| Command | Purpose |
| --- | --- |
| `docker compose up --build -d --wait backend worker` | Start or update the stack and wait for readiness |
| `docker compose logs backend worker` | Inspect local service logs with request IDs |
| `docker compose run --rm -T admin demo a-new-slug` | Provision a new local tenant and emit its one-time key |
| `docker compose --project-name aegis-backend-test --profile test run --build --rm tests` | Run backend tests against an isolated Compose project |
| `docker compose down` | Stop the local stack |

The database volume persists across ordinary restarts. If you deliberately want to reset a disposable test database, target the test project with `docker compose --project-name aegis-backend-test down -v`. Store test logs outside the source tree or use an ignored path. Local Docker parsing was verified. The service smoke used the direct process setup below because a Docker daemon was unavailable in the verification environment.

## Direct services

Use Python 3.12 or newer, PostgreSQL, and Redis. The tested dependency versions and host details are in the [verification report](../VERIFICATION.md). For a disposable database, create distinct gateway, worker, and admin roles using the [Compose bootstrap](../infra/compose/init-roles.sh) as a pattern. The migration role must own the schema. Give services only their respective login, including the recovery worker.

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --require-hashes -r backend/requirements-test.lock
python -m pip install --no-deps -e backend
alembic -c backend/alembic.ini upgrade head
pytest -q backend/tests
ruff check backend benchmarks scripts
ruff format --check backend benchmarks scripts
```

Set `AEGIS_MIGRATION_DATABASE_URL` before Alembic. Set `AEGIS_TEST_DATABASE_URL`, `AEGIS_TEST_ADMIN_URL`, `AEGIS_TEST_WORKER_URL`, and `AEGIS_TEST_REDIS_URL` for pytest. Tests skip integration cases when their required service URLs are absent. Use only disposable stores because tests create tenants, policies and ledger entries.

For an interactive gateway use the `AEGIS_DATABASE_URL`, `AEGIS_REDIS_URL`, `AEGIS_KEY_PEPPERS` and `AEGIS_CURSOR_SECRET` settings, plus optional collector and OIDC settings. Start the gateway with these values in its environment.

```bash
uvicorn aegis.main:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log --no-proxy-headers
```

Run `aegis-worker` separately with the worker database URL. Run provisioning commands with `AEGIS_ADMIN_DATABASE_URL` and the same environment and key-pepper configuration. The app does not read a dotenv file by itself in this direct startup path. Compose supplies environment variables to its services.

## Console and browser checks

Run `npm --prefix frontend ci` and `npm --prefix frontend run dev` with Node.js 22+. Set the development origin exactly in `AEGIS_ALLOWED_ORIGINS`. In particular, `localhost` and `127.0.0.1` are different origins. [Console integration map](../frontend/README.md)

To reproduce the browser verification, build the static output, install a compatible Chromium, and start the smoke harness with the test service variables above.

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
(cd frontend && npx --no-install playwright install chromium)
python scripts/console_smoke.py --logs .aegis-qa-work/console-smoke
```

The harness provisions two disposable tenants, launches a mock-only gateway and optionally a reconciliation worker, and uses a locally signed OIDC token. It keeps fixture credentials in process environments. Run the [Locust benchmark](../benchmarks/README.md) separately to avoid mixing performance and browser workloads.
