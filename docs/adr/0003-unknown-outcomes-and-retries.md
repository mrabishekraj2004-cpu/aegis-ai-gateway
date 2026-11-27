# ADR 0003: Unknown provider outcomes are reconciled, never retried blindly

- Status: Accepted
- Date: 2026-11-27

## Decision

Only fail over when the adapter establishes that no provider execution occurred. If a request may have executed, preserve the reservation and reconcile using a provider retrieval API. If the provider offers no safe retrieval path, retry to a dead-letter state for operator review.

## Consequences

OpenAI Responses mode stores a response ID and can query usage. OpenAI Chat Completions and Anthropic Messages currently cannot be retrieved through these adapters. Those cases remain pending until provider account logs or another authoritative receipt is available. This favors correct billing over automatic release.
