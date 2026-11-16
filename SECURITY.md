# Security

## Report a vulnerability

Use the repository's private vulnerability form when enabled. Otherwise contact the repository maintainer privately. Share the affected revision, reproduction steps using a disposable tenant, and any redacted request IDs. Keep service credentials, prompts and upstream responses out of the report.

## Trust boundaries

- SDK clients use tenant-scoped service keys. The repository uses a random secret with a versioned HMAC digest and stores the corresponding peppers outside the database.
- The console uses in-memory bearer credentials. Policy administration requires a short-lived RS256 token and verified tenant membership. A service key cannot administer routing.
- PostgreSQL uses forced row-level security and separate gateway, worker, migrator and administrator roles. Use the least privileged role for each process.
- Provider credentials and the collector token belong in server-side environment injection or a managed secret store. Deny public ingress to the metrics path alongside its bearer check.
- Keep exact browser origins in the CORS configuration. Use HTTPS for remote console access, PostgreSQL `sslmode=verify-full`, and verified TLS for managed Redis.

Local Compose binds the gateway to loopback and places PostgreSQL and Redis on its private network. Rotate fixture values between environments. Use defense in depth at ingress for request size, abusive connections and authentication attempts.

The [verification report](VERIFICATION.md#security-audit) records dependency and source scans, isolation and logging checks, and the limits of local verification. Git history scanning is configured in [CI](.github/workflows/verify.yml).
