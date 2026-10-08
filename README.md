# WitnessOps

Release control, deployment verification, and PostgreSQL recovery evidence in one local-first product.

WitnessOps has one public npm package, one `witness` command, a browser console, a macOS Electron app, and a GitHub Action. The local agent owns the serial job queue and SQLite run journal. The deploy and database modules use the same verification engines in the CLI and console.

This is an early alpha. The agent binds only to `127.0.0.1`; it is not a public web service. Release execution and the app require macOS. Deploy verification and PostgreSQL commands also run on Linux.

## Install

Requires Node.js 24 or newer. The source workspace uses pnpm 12.4.2.

```sh
npm install --global @erol.senol/witness-ops@alpha
witness --version
witness --help
```

From source:

```sh
pnpm install --frozen-lockfile
pnpm check
node src/cli.mjs --help
```

The Electron ZIP is a separate asset on the matching GitHub Release. It bundles the Node 24 runtime used by its local agent.

## CLI

```sh
witness release plan --all
witness release check --project example
witness release build --project example
witness release deploy --project example --sha <verified-build-sha> --manifest-hash <verified-manifest-sha256> --confirm <sha-first-12>
witness deploy verify --config /private/deploy-witness.yml --expected-sha <40-character-sha>
witness db doctor example --config /private/restore-witness.json
witness db drill example --config /private/restore-witness.json
witness setup
witness app
```

`witness release` uses the local project catalog described below. `witness deploy` retains DeployWitness's config/report contract and exit codes. `witness db` retains RestoreWitness's backup, verification, recovery, scheduling, and retention contracts. `witness --version`, `witness deploy --version`, and `witness db --version` report the WitnessOps release version.

For complete provider and database configuration details, see [deploy verification](packages/deploy-witness/docs/support-policy.md) and [database recovery](packages/restore-witness/docs/RECOVERY.md). Existing DeployWitness config v1/v2 and report v1 files remain readable. RestoreWitness legacy manifests remain readable.

## Local console

On macOS, run `witness app` and open the session URL printed in its terminal, or use the Electron app. The URL fragment supplies a random session token to the browser; keep it private. Electron starts its own agent on an available loopback port. Release, Deploy verification, and Database recovery share one job list. Reports are available through the local agent after a run; treat them as private operational data.

Run `witness setup` to create a private empty catalog at `~/Library/Application Support/WitnessOps/projects.json`, then add projects using [the project catalog example](config/projects.example.json) and their native check commands. The setup command never overwrites an existing catalog. Set `WITNESS_CONFIG` to use another absolute path. The catalog may be empty; the app then opens with setup guidance and no runnable projects. Do not commit your real catalog or credentials.

For a project's Deploy verification card, add:

```json
"deployVerification": { "configPath": "/private/deploy-witness.yml" }
```

For its Database recovery card, add:

```json
"databaseRecovery": {
  "configPath": "/private/restore-witness.json",
  "projectId": "example",
  "beforeDeploy": false
}
```

Set `beforeDeploy` to `true` only when a passing RestoreWitness drill should block that project's deploy. If `deployVerification` is configured, DeployWitness runs after the native receiver and smoke check. A failed post-deploy verification leaves the run at `needs_attention`; it never automatically retries or rolls back. Capture provider tokens through the agent process environment. `COOLIFY_API_BASE_URL` is required for optional Coolify status reading.

For project-specific release ledger and rollback evidence, add a `releaseEvidence` section to that project. The logical names must match the image names in its receiver ledger:

```json
"releaseEvidence": {
  "sshTarget": "operator@trusted-host.example",
  "ledgerDirectory": "/var/lib/your-app/releases",
  "imagePrefix": "local-release/your-app-",
  "containers": [{ "logicalName": "api", "containerName": "your-app-api" }]
}
```

Existing single-project `WITNESS_RELEASE_*` environment settings still work. Configure `releaseEvidence` per project when managing multiple applications. Release jobs in separate CLI and app processes use the same SQLite operation lock and wait their turn before starting.

The agent stores its SQLite journal and evidence reports under `~/Library/Application Support/WitnessOps` by default. Set `WITNESS_DATA_DIR` to override it. The old DeployRelay data directory is left in place; move data only after inspecting it. The original repositories and npm package versions remain available as archived migration references.

The session token protects the operational API, including evidence downloads. A local process running as the same user can still inspect its own agent environment and files; use a trusted operator account. A browser opened without the printed session URL shows an unavailable agent.

## GitHub Action

Use the root Action after deployment and pin it to a reviewed full commit SHA:

```yaml
- uses: erolsenol/witness-ops@<full-commit-sha>
  with:
    config: deploy-witness.yml
    expected-sha: ${{ github.sha }}
    started-after: ${{ steps.deploy-boundary.outputs.timestamp }}
    coolify-token: ${{ secrets.COOLIFY_READ_ONLY_TOKEN }}
```

The Action only verifies deployments. It uses the same DeployWitness engine as `witness deploy verify`. Existing `erolsenol/deploy-witness@<sha>` Action references remain valid in the archived repository.

## Architecture and safety

The browser sends allowlisted project IDs and actions, never shell commands or paths. The agent runs one job at a time and records stage outcomes without raw command output. Deployment and rollback still require verified native artifacts and explicit operator confirmation. The optional release ledger reader accepts only locally configured SSH target, ledger directory, container names, and image prefix; it does not expose the agent on a public interface. See [architecture](docs/ARCHITECTURE.md), [private SSH access](docs/REMOTE.md), and [security boundaries](SECURITY.md).

## License

MIT.
