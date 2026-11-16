# Offline mock benchmark

The benchmark runner provisions disposable tenants and starts two localhost Uvicorn processes that share PostgreSQL and one Redis primary. Every user repeats a deterministic mix of 70% JSON completions, 20% SSE completions and 10% model listings. Requests rotate among fixture keys and both replicas. JSON completions must report usage. SSE must end with one `[DONE]` frame and contain no error event.

Prepare the local database roles, upgrade Alembic to head, and install the backend as described in the [project README](../README.md). Use disposable services and provide their runtime, admin and Redis connection strings in `AEGIS_TEST_DATABASE_URL`, `AEGIS_TEST_ADMIN_URL` and `AEGIS_TEST_REDIS_URL`. Install `locust==2.47.0` in a separate tooling environment. Run from the project root with the backend Python active.

```sh
python benchmarks/run_mock.py --locust /path/to/locust \
  --output .aegis-qa-work/example-load --tenants 251 --users 4 16 --duration 20
python benchmarks/report.py .aegis-qa-work/example-load
```

The command generates ephemeral fixture credentials in memory. It disables trace export and uses only the mock deployment. The ordinary Redis quotas remain active. Use a new output directory and keep raw gateway logs in that local directory. The runner exits nonzero if any Locust request failed and retains the measurements for diagnosis.

Client response percentiles use Locust's final rounded histogram, including failures. The scorer metric measures Python score evaluation after catalog and Redis signals have loaded. Admission includes authentication, routing and the first durable attempt authorization. SSE is measured through its terminal frame. The synthetic workload exercises gateway overhead and the ledger.
