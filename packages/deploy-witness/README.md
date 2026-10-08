# DeployWitness

> Prove that the commit you expected is the commit your users can reach.

DeployWitness is an open-source CLI and GitHub Action for checking deployments after your CI/CD system has run. Coolify and Vercel adapters read deployment records, while public HTTP endpoints are probed separately. It produces a machine-readable report and a clear pass/fail result.

DeployWitness verifies; it does not deploy, roll back, run migrations, or change provider state.

## What it checks

- The latest deployment belongs to the configured Coolify application or Vercel project and target.
- The provider reports a successful terminal state.
- The deployment commit exactly matches the expected full Git SHA.
- If `started-after` is provided, the provider deployment must have been created after that CI run boundary; without it, the report warns that it cannot correlate the deployment to the current run.
- Configured health endpoints and optional version markers respond as expected.
- Optional stability checks can require several consecutive successful responses after the deployment.
- Every check is reported separately, with missing or unknown evidence kept visible.
- Provider capabilities are reported as `SUPPORTED`, `UNSUPPORTED`, or `UNAVAILABLE` for this run, so consumers can distinguish missing support from an inaccessible provider API.
- Coolify and Vercel status, commit, target, and freshness evidence is evaluated by one shared decision module after each adapter normalizes provider data.
- An optional expected OCI image digest is checked separately from the Git commit; current Coolify and Vercel deployment APIs do not expose a verified observed image digest, so requesting this check produces required `UNSUPPORTED` evidence and cannot yield PASS.

An HTTP 200 alone does not prove that the requested commit is live. Add a version endpoint or response header if you need an independent runtime commit check.

For an endpoint that briefly flaps during startup, add bounded stability to that probe. The per-probe `timeoutMs` remains the total deadline; attempts are capped at 20 and failed attempts reset the consecutive-success count:

```yaml
probes:
  - name: public-health
    url: https://app.example.com/health
    stability:
      consecutiveSuccesses: 3
      intervalMs: 1000
```

## Quick start

Requirements: Node.js 22 or newer. Install the CLI from npm and create a starter configuration:

```sh
npm install --global deploy-witness
deploy-witness init
```

Edit `deploy-witness.yml` with the Coolify base URL, application resource UUID,
and public health/version probe URLs. Keep provider credentials out of the
config; set the read-only token in your shell or CI secret store, then validate
and run the check:

```sh
deploy-witness config validate
# Run after deployment in CI, where GITHUB_SHA identifies the expected commit.
# Inject COOLIFY_API_TOKEN from the CI secret store; do not paste it into this file.
deploy-witness verify \
  --expected-sha "$GITHUB_SHA" \
  --started-after "$DEPLOY_STARTED_AT" \
  --report deploy-witness-report.json \
  --junit deploy-witness.xml
```

Capture `DEPLOY_STARTED_AT` immediately before the deployment step. The
complete read-only staging acceptance workflow and its required GitHub
Environment settings are documented in
[`docs/staging-validation.md`](docs/staging-validation.md).

For Vercel, initialize with `deploy-witness init --provider vercel` and set
`VERCEL_TOKEN`. The GitHub Action and source repository are public. npm
installation is available from the public npm registry; pin the Action to a
reviewed commit SHA.

`config validate` checks the effective configuration. `config explain` shows the file path, applied override names, and planned check IDs without printing configuration values. Explicit CLI flags take precedence over environment variables, which take precedence over YAML/JSON:

| Environment variable | Overrides |
| --- | --- |
| `DEPLOY_WITNESS_COOLIFY_BASE_URL` | `coolify.baseUrl` |
| `DEPLOY_WITNESS_COOLIFY_RESOURCE_UUID` | `coolify.resourceUuid` |
| `DEPLOY_WITNESS_EXPECTED_SHA` | `deployment.expectedSha` |
| `DEPLOY_WITNESS_STARTED_AFTER` | `deployment.startedAfter` |
| `DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST` | `deployment.expectedImageDigest` in config v2 |
| `DEPLOY_WITNESS_VERCEL_PROJECT_ID` | `vercel.projectId` |
| `DEPLOY_WITNESS_VERCEL_TEAM_ID` | `vercel.teamId` |
| `DEPLOY_WITNESS_VERCEL_TARGET` | `vercel.target` (`production` or `preview`) |

Provider tokens are secret inputs and are not part of config inspection or reports.

For Vercel, use `deploy-witness init --provider vercel`, provide the project ID and target, and set `VERCEL_TOKEN`. Team projects may also set a team ID. DeployWitness lists only that project and target, then requests the deployment detail with Git repository information to compare its full commit SHA. The Vercel token is used only for read-only GET requests.

To record an expected immutable OCI digest, use config v2's `deployment.expectedImageDigest`, pass `--expected-image-digest sha256:<64-hex-characters>` to the CLI, set `DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST`, or use the Action's `expected-image-digest` input. The order is CLI/Action input, environment, then config file. This validates the digest format and emits a required provider digest check. A config v2 probe can use `imageDigestJsonPath` to compare the same expectation with an app runtime marker without duplicating the digest value:

```yaml
deployment:
  expectedImageDigest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
probes:
  - name: runtime-image
    url: https://app.example.com/api/version
    imageDigestJsonPath: build.imageDigest
```

The runtime marker is independent and does not replace provider-side digest evidence. A valid runtime digest is recorded in the report as the normalized expected and observed values; missing and malformed values are recorded as `null` with distinct failure codes. The current [Coolify deployment record](https://coolify.io/docs/api/endpoints/deployments/list-deployments-by-app-uuid) and [Vercel deployment detail](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url) contracts do not include an observed immutable image digest, so this provider check is `UNSUPPORTED` and the overall result is `INCOMPLETE`; a tag or configured image reference is never treated as the observed digest.

See the [image digest evidence decision record](docs/adr/0002-image-digest-evidence.md) for config migration and the separation between provider and runtime digest checks.

The Vercel adapter uses the official [deployment list endpoint](https://vercel.com/docs/rest-api/deployments/list-deployments) scoped by project and target, then the [deployment detail endpoint](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url) with `withGitRepoInfo=true`. Vercel represents preview deployment `target` as `null`; DeployWitness normalizes that documented value to `preview`.

Deployment history is read in bounded pages: Coolify uses its documented [`skip`/`take` pagination](https://coolify.io/docs/api/endpoints/deployments/list-deployments-by-app-uuid), and Vercel follows the documented [`pagination.next` cursor](https://vercel.com/docs/rest-api/deployments/list-deployments) with `until`. The scan stops after five pages or the verification deadline. If that bound is reached before history is complete, deployment ordering is reported as unknown and verification cannot pass on incomplete history.

## JSON Schema contracts

The versioned config and report schemas live in [`schemas/`](schemas/). Regenerate them after changing the Zod contracts with `npm run schema:generate`; CI checks that the committed schemas stay synchronized. You can print the current config v2 schema with `node dist/cli.js schema config` or select `config-v1`, `config-v2`, and `report` explicitly. JSON Schema documents structural constraints; run `config validate` for DeployWitness-specific semantic and security validation before using a configuration.

### v1 compatibility boundary

Config v1 accepts only its documented fields and requires `version: 1`; unknown fields and unsupported versions are errors. Config v2 adds `deployment.expectedImageDigest` and is available in [`config-v2.schema.json`](schemas/config-v2.schema.json); new `init` files use v2, while v1 files continue to load unchanged. Report v1 requires `schemaVersion: 1` and rejects fields outside its published schema. Consumers should branch on the config/report version and validate against the matching schema. Changes to a version's decision meanings or shape require a new schema version and migration guidance; a v1 reader must not silently reinterpret a newer version.

Reports include a `capabilities` inventory. `SUPPORTED` means the adapter can verify that behavior, `UNSUPPORTED` means the adapter does not implement it, and `UNAVAILABLE` means a supported feature could not be confirmed because the provider API was inaccessible during that run. Capability information is informational and does not replace required deployment checks.

See the [report v1 evidence and freshness decision record](docs/adr/0001-evidence-and-freshness-v1.md) for the required/optional decision matrix and evidence limits. Schema-validated [correlated PASS](examples/report-pass-v1.json), [uncorrelated PASS with warning](examples/report-pass-uncorrelated-v1.json), and [stale deployment FAIL](examples/report-stale-v1.json) reports are available as consumer examples.

JUnit output preserves the verification decision: required warnings and failures become failures, required unknown/unsupported/skipped checks become errors, and optional non-pass checks remain skipped so they do not turn an overall PASS into a failing CI result.

For CI providers without GitHub Actions, see the [GitLab CI example](examples/gitlab-ci.yml) and its [setup notes](docs/ci-integrations.md).

## GitHub Actions

The Action runs after your deploy step. Store the read-only provider token as a GitHub Actions secret and provide it through the matching Action input; never put the token in the config file.

    # Capture the boundary immediately before your deployment step, then run
    # the deployment step, and place DeployWitness after it.
    - name: Mark deployment start
      id: deploy-witness-boundary
      shell: bash
      run: echo "timestamp=$(node -p 'new Date().toISOString()')" >> "$GITHUB_OUTPUT"

    - name: Verify deployment
      uses: erolsenol/deploy-witness@42bef07ebcf0a66097ce4c67325b7916a195c044
      with:
        config: deploy-witness.yml
        coolify-token: ${{ secrets.COOLIFY_READ_ONLY_TOKEN }}
        expected-sha: ${{ github.sha }}
        started-after: ${{ steps.deploy-witness-boundary.outputs.timestamp }}

For repeatable positive and negative provider checks against a non-production
Coolify app, follow the [staging validation guide](docs/staging-validation.md).

For Vercel, select a `provider: vercel` config and pass `vercel-token: ${{ secrets.VERCEL_READ_ONLY_TOKEN }}` instead. The Action masks either provider token before verification.

Create a Coolify configuration with `deploy-witness init` or a Vercel configuration with `deploy-witness init --provider vercel`. Set the relevant project/resource identifier, target, timeout and probes in `deploy-witness.yml`. Run this step only in a trusted workflow that is allowed to access the provider token. Do not pass deployment secrets to untrusted fork pull requests.

## Security and evidence boundaries

- Provider access is read-only.
- Coolify and Vercel tokens are masked in GitHub Actions and are never written into the JSON report.
- HTTP probe redirects are not followed; the Coolify token is never sent to probe URLs.
- Probe DNS answers are checked and connections are pinned to a validated address; private and special-use ranges are rejected.
- Localhost HTTP is disabled unless a probe explicitly sets `allowLocalHttp: true`.
- CLI can emit JUnit XML with `--junit <path>` for CI test-report ingestion.
- A provider status or response field DeployWitness does not recognize is reported as unknown, not success.
- Reports are diagnostic evidence, not a cryptographic attestation or proof that the provider itself is trustworthy.

See [SECURITY.md](SECURITY.md), the [support and compatibility policy](docs/support-policy.md), [the architecture and roadmap](docs/plan.md), and [the task list](tasks/todo.md).

The planned optional artifact provenance boundary is recorded in [ADR 0003](docs/adr/0003-github-artifact-attestation.md). It is not an implemented verification feature in this release.

## Releases

### Upgrading to 0.3.0

Runtime probes run with at most four workers by default, and report checks stay in configuration order even when requests finish out of order. Set `verify --probe-concurrency 1` for sequential checks or choose an integer up to 20. The GitHub Action accepts `probe-concurrency: "4"`; Node API callers can pass `probeConcurrency: 4` to `runVerification`. The limit applies to the entire probe, including stability retries. Each probe's timeout starts when a worker starts it; queued time is not charged to that timeout. Provider polling keeps its separate deployment timeout.

Probe names must produce distinct check IDs: lowercasing, punctuation normalization, and truncation to 48 characters can cause different names to collide. Rename such probes before upgrading, then run `config validate` or `config explain`. Existing non-colliding IDs, config v1/v2 fields, report v1, and exit codes are unchanged. Set concurrency to 20 to restore the previous maximum parallelism.

Coolify and Vercel responses are limited to 2 MiB while streaming, including responses without `Content-Length`. Oversized responses produce `COOLIFY_RESPONSE_TOO_LARGE` or `VERCEL_RESPONSE_TOO_LARGE`; interrupted bodies produce provider-specific `RESPONSE_READ_FAILED`, and expired request deadlines produce `REQUEST_TIMEOUT`. Provider errors never include raw response content. Real provider acceptance remains separate from local fixture and consumer tests.

Version tags run the full release quality gate and create a GitHub Release. npm publication is a separate manually dispatched workflow that requires an `NPM_TOKEN` secret for the `erol.senol` npm account in the `npm-publish` GitHub Environment. The workflow verifies the account, checks that the selected tag matches `package.json`, rebuilds and tests the package, publishes with npm provenance, and verifies the registry publisher. OIDC Trusted Publishing records `GitHub Actions` as the publisher; account authentication keeps npm's `Published by` attribution on `erol.senol`. See [CHANGELOG.md](CHANGELOG.md) for release contents.

For an interactive local release, run `npm login --auth-type=web`, confirm `npm whoami` prints `erol.senol`, run `npm run lint`, `npm run schema:check`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run consumer:smoke`, then run `npm publish --access public --registry=https://registry.npmjs.org`. Complete any npm browser/2FA prompt directly. Local publishing does not generate GitHub Actions provenance. Verify `npm view deploy-witness@<version> _npmUser --json` records `erol.senol`; changing `author` alone does not change the publisher. An already published version cannot be overwritten.

## Development

    npm ci

Husky installs the local Git hooks during `npm ci`. Before each commit, the
`pre-commit` hook runs lint and checks that the committed JSON schemas match the
source contracts. Before each push, the `pre-push` hook runs the complete
quality gate: lint, schema check, typecheck, tests, build, and package dry run.
If a check fails, Git stops the commit or push. Run these commands manually with
`npm run lint`, `npm run schema:check`, `npm run typecheck`, `npm test`,
`npm run build`, `npm run consumer:smoke`, and `npm pack --dry-run` when needed.

## License

MIT. See [LICENSE](LICENSE).

### Saved report validation (0.4.0)

Validate a saved JSON report offline and export its checks for another CI job:

```sh
npx deploy-witness@0.4.0 report deploy-witness-report.json --junit deploy-witness.xml
```

No provider token or network request is needed. Exit codes match `verify`: PASS 0, FAIL 1, INCOMPLETE 3; invalid/unreadable/inconsistent reports and output errors return 2. Inputs must be regular UTF-8 JSON files up to 4 MiB. The loader checks the strict report v1 contract, unique check IDs, at least one required check and agreement between the stored decision and check outcomes. Terminal output removes control characters; all report artifacts use mode 0600, including atomically replaced files (0.5.0+).

This checks saved evidence consistency, not authenticity, freshness or the current live deployment. Treat report artifacts as sensitive and obtain them from a trusted CI job. Existing config v1/v2 and report v1 fields are unchanged.

The public API exports `parseVerificationReport(value: unknown)`, `loadVerificationReport(path)`, `ReportLoadError`, `MAX_REPORT_BYTES`, `renderTerminal` and `verificationExitCode`.

### Markdown reports and artifact safety (0.5.0)

```sh
npx deploy-witness@0.5.0 verify --expected-sha "$GITHUB_SHA" --report report.json --junit report.xml --markdown report.md
npx deploy-witness@0.5.0 report report.json --junit report.xml --markdown report.md
```

The GitHub Action step summary and CLI Markdown artifacts use the same reporter: provider/resource, expected commit, run/time/tool version, and each check's required flag, status, failure code and escaped summary. Raw evidence values are kept in JSON. Public API: `renderMarkdown(report)` and `writeReportArtifacts(artifacts, protectedPaths?)`.

All output paths are checked before writing. Outputs cannot overlap each other or the input config/saved report, including existing hard-link and parent-directory aliases. Symlink and non-regular destinations are rejected. Every artifact is written to a private temporary file in its destination directory and atomically renamed, with mode 0600 even when replacing an existing file. Missing parent directories return a safe write error; temporary files are cleaned up. Each file replacement is atomic; multiple outputs are not a filesystem transaction and concurrent directory mutation is outside this guarantee. Use distinct artifact paths in a runner-owned directory.

Config/report schema fields and decision exit codes are unchanged. The Action summary now uses Markdown rather than the previous HTML table.
