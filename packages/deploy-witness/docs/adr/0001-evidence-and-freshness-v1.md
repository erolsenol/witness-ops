# ADR 0001: Evidence and freshness semantics for report v1

- **Status:** Accepted
- **Date:** 2026-09-30
- **Scope:** Config v1 and report v1; applies to Coolify and Vercel adapters.

## Context

A successful provider deployment record is useful evidence, but it does not by itself prove that the current CI run caused that deployment or that users can reach the expected runtime. Consumers need stable decision semantics and must be able to tell missing evidence from a negative result.

## Decision

Adapters normalize provider responses. The shared evaluator applies the same required checks to deployment status, full source SHA, and freshness. Report v1 remains additive and schema-versioned; changing these semantics incompatibly requires a new schema version.

| Check result | Required check effect | Optional check effect |
| --- | --- | --- |
| `PASS` | Satisfies this check | Satisfies this check |
| `FAIL` | Overall `FAIL` | Reported; does not fail the overall decision |
| `UNKNOWN`, `UNSUPPORTED`, `SKIP` | Overall `INCOMPLETE` unless a required check already failed | Reported; does not block overall `PASS` |
| `WARN` | Overall `FAIL` | Reported; does not block overall `PASS` |

The overall decision is `PASS` only when every required check is `PASS`. A required `FAIL` takes precedence over incomplete checks. Otherwise, any required `UNKNOWN`, `UNSUPPORTED`, or `SKIP` yields `INCOMPLETE`.

### Freshness and run correlation

- When `startedAfter` is supplied, the selected deployment must have a usable creation timestamp strictly later than the boundary. Equal or older timestamps fail with `DEPLOYMENT_STALE`; a missing or unusable timestamp is `UNKNOWN`. Neither can produce a pass.
- When `startedAfter` is omitted, freshness is an optional `WARN` with `DEPLOYMENT_RUN_CORRELATION_UNAVAILABLE`. A report may still be `PASS` if all required checks pass, but it does not claim the current run created the deployment.
- Deployment ordering is bounded by provider pagination and deadlines. If the adapter cannot determine the relevant deployment confidently, it reports uncertainty instead of selecting a convenient historical match.

### Evidence boundaries

| Evidence | Can support | Does not establish |
| --- | --- | --- |
| Provider deployment status | Provider reported a successful terminal deployment | Runtime is reachable or serves the expected build |
| Provider source SHA | The deployment record names the expected full Git revision | The built image is immutable or the running process uses it |
| Provider creation timestamp and `startedAfter` | The deployment record is newer than the supplied CI boundary | Causal identity if the boundary was captured incorrectly |
| HTTP status | The endpoint returned the expected status during the probe | Source revision or image identity |
| Configured runtime marker | The endpoint exposed the configured scalar marker | Provider-side deployment state or cryptographic provenance |
| OCI image digest, when supported in a future check | Immutable image identity | That the image is running unless independently observed at runtime |

Reports are diagnostic evidence, not cryptographic attestations and not proof that a provider is trustworthy. `examples/report-pass-v1.json` demonstrates a correlated pass; `examples/report-pass-uncorrelated-v1.json` demonstrates the explicit optional warning; `examples/report-stale-v1.json` demonstrates a deployment rejected by the run boundary. All examples are validated against the checked-in report v1 contract.

## Consequences

- Consumers can distinguish negative evidence (`FAIL`) from insufficient evidence (`INCOMPLETE`).
- Omitting a run boundary is visible and non-blocking for compatibility; workflows that require run correlation should always supply it.
- Adding digest or attestation checks requires separate evidence IDs and explicit capability/policy semantics. A Git tag or provider success state must never be treated as an immutable image digest.
- Config v1 and report v1 remain unchanged by this decision. Breaking changes require a migration guide and a new schema version.
