# Observed mock performance

Measured November 16, 2026 Eastern time. The isolated x86-64 Linux 6.18.57 host reported nine logical CPUs. Two one-worker Uvicorn processes on Python 3.12.14 shared PostgreSQL 17.11, Redis 7.0.15 and the same host with Locust 2.47.0. The deterministic mock used one deployment. The 251-tenant workload ran 20 nominal seconds at four users, then 20 nominal seconds at 16 users. Locust drove requests without think time. Both runs used the same 70/20/10 JSON/SSE/catalog mix and standard Redis limits. No paid provider credentials were configured.

| Revision | Concurrent users | Completed observations | Errors | Requests/s | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Before request-path fixes | 4 | 1,613 | 0 | 81.95 | 49 | 75 | 120 |
| Before request-path fixes | 16 | 1,552 | 0 | 78.03 | 190 | 370 | 530 |
| After request-path fixes | 4 | 1,618 | 0 | 82.23 | 48 | 81 | 120 |
| After request-path fixes | 16 | 1,881 | 0 | 94.17 | 150 | 340 | 400 |

| Fixed revision | Mean JSON scorer | Mean SSE scorer | Mean JSON admission | Mean SSE admission |
| --- | ---: | ---: | ---: | ---: |
| 4 users | 52.47 µs | 51.02 µs | 35.81 ms | 40.48 ms |
| 16 users | 52.51 µs | 53.23 µs | 132.39 ms | 132.56 ms |

An exploratory 41-tenant profile intentionally retained the same quotas. It returned 1,534 failures in 2,721 requests at four users and 2,036 in 3,197 at 16 users. Those failures were HTTP 429 quota responses. The 251-tenant profiles represent a workload with sufficient tenant entitlement. The separate concurrency tests cover exact quota admission and hot-tenant budget contention.

These short single trials show an improvement at 16 users and no clear performance change at four users. Host scheduling and separate fixture runs limit attribution. The production availability, 100 accepted requests/s, p95 admission below 75 ms, 200 simultaneous streams and sustained capacity gates remain open. The fixture also excludes managed provider networks, TLS termination, Redis promotion and long-running soak conditions. [Reproduction commands](README.md) · [Before measurements](evidence/baseline/run.json) · [After measurements](evidence/verified/run.json)
