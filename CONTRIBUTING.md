# Contributing

Use a disposable tenant and local mock credentials when developing. The [local setup](docs/local-development.md) covers both Compose and directly started services.

1. Keep application changes aligned with the [API contract](docs/api.md). If a public request or response schema changes, regenerate the frontend declarations and review the schema diff.
2. Run targeted tests and the [applicable verification commands](VERIFICATION.md#commands-and-results). Include an integration test for a change to tenant isolation, stream commitment, or spend authorization when existing coverage does not exercise the failure mode.
3. Record new architecture trade-offs in an [ADR](docs/adr/README.md). Keep proposals in [BLUEPRINT.md](BLUEPRINT.md) and implementation claims in the relevant technical documentation.
4. Include the fixture, tools, and measurement window for performance claims. Use the [benchmark harness](benchmarks/README.md).

Never attach bearer tokens, database exports, prompts, or provider payloads to a public issue or pull request. Use the [security reporting guidance](SECURITY.md) for vulnerabilities.
