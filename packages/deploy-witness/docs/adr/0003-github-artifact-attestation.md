# ADR 0003: GitHub artifact attestation verification boundary

- **Status:** Accepted
- **Date:** 2026-10-01
- **Scope:** Optional build-provenance verification for GitHub artifact attestations.

## Context

Deployment verification and build provenance answer different questions. A
provider record and a runtime probe describe deployment and serving behavior;
an artifact attestation describes a signed claim about how an artifact was
produced. Combining them must not imply that production is running that
artifact. The current report v1 is strict and has no `supply-chain` check
category, while config v1/v2 are also strict.

GitHub CLI `gh attestation verify` verifies the signature and trusted
timestamps and can enforce repository, signer workflow, predicate type, source
digest, and the digest of the artifact being verified. It can verify a local
file or an OCI reference. JSON output also contains workflow-controlled
predicate data, which must not be treated as independently trusted policy
evidence.

## Decisions

1. Do not add attestation fields or check categories to config v1/v2 or report
   v1. Attestation support requires a new config schema and report schema, with
   explicit migration and consumer validation. Existing v1 consumers retain
   their current strict meaning.
2. The verifier delegates cryptographic signature, certificate, timestamp,
   and trust-root verification to GitHub CLI. DeployWitness will not implement
   Sigstore verification itself. It invokes the executable without a shell,
   constructs arguments only from validated config, applies an execution
   deadline and output-size bound, and redacts credentials and raw subprocess
   output from reports.
3. The policy must pin an exact source repository, signer workflow identity,
   expected full source commit, expected subject digest, and the accepted
   SLSA provenance predicate type. The artifact is supplied as a local file or
   immutable OCI digest reference; mutable tags alone are insufficient.
4. Verification succeeds only when the verifier exits successfully and the
   returned result contains the expected subject digest, repository, signer
   workflow, source commit, predicate type, a verified signature certificate,
   and at least one verified timestamp. No statement predicate fields beyond
   these explicit identity checks may affect the decision.
5. Attestation verification is disabled unless configured. When configured,
   `required` defaults to `false`; optional absence is reported without
   blocking a deployment PASS. A required absence or unavailable verifier is
   `UNKNOWN` and therefore cannot PASS; a cryptographic or identity mismatch
   is `FAIL`.
6. Supply-chain evidence is a separate category in the next report version.
   It never substitutes for provider deployment identity, provider image
   digest, or runtime marker checks, and it must be described as build
   provenance only.
7. The first supported verifier is GitHub CLI. Its availability and supported
   version are checked explicitly. GitHub API or OCI registry access may be
   required depending on the artifact source; errors are classified without
   exposing tokens or raw response bodies.

## Required validation before implementation is complete

- Trusted positive attestation for a real release artifact.
- Wrong repository, workflow, source commit, subject digest, and predicate
  each fail closed.
- Missing attestation, unavailable CLI, timeout, malformed output, and invalid
  signature cannot produce PASS; optional and required policies follow the
  decision table above.
- Tests prove raw CLI output, predicate contents, and credentials do not leak
  into JSON/JUnit reports or logs.
- A positive attestation result is presented separately from deployment and
  runtime evidence in report and documentation examples.

## Consequences

- Config v3 and report v2 design must precede the verifier implementation.
- Consumers must opt in and install or provide the supported GitHub CLI
  verifier until a separately reviewed portable verifier is justified.
- A passing provenance check only establishes that the expected trusted
  workflow made a claim about the expected artifact. It does not establish
  that a provider deployed or currently serves that artifact.

## References

- [GitHub CLI `gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify)
- [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
