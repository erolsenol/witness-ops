# WitnessOps release and evidence

WitnessOps is a local operator tool. A release contains the source package, the
GitHub Action bundle, and an Apple Silicon Electron application. The desktop
application includes the local agent and console, starts the agent on launch,
and keeps the agent bound to loopback. The application is unsigned and not
notarized unless the release notes explicitly say otherwise.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm run preflight
/Users/erolsenol/.local/bin/dev-run --wait -- pnpm check
pnpm make:desktop
```

The release helper requires a clean, pushed `main`, matching workspace
versions, authenticated GitHub CLI, and explicit release notes:

```sh
pnpm release:github -- --notes /absolute/path/to/release-notes.md --dry-run
pnpm release:github -- --notes /absolute/path/to/release-notes.md
```

## Evidence meaning

- `plan` reads source state and configured steps without running quality gates.
- `check` proves configured native checks passed on one clean SHA.
- `build` proves the configured build and manifest verification passed on that
  SHA and records the manifest hash.
- `deploy` and `rollback` require explicit operator confirmation and preserve
  uncertain outcomes as `needs_attention`.
- `witness deploy` observes provider/runtime evidence; it does not deploy or
  mutate provider state.
- `witness db` keeps backup, restore, monitoring, scheduling, retention, and
  recovery evidence separate from deployment evidence.

GitHub release, npm registry publication, desktop archive integrity, Action
consumer smoke, and clean npm consumer installation are separate evidence
claims. A local check or a healthy public endpoint alone does not prove a
published or deployed release.
