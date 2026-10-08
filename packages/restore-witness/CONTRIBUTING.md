# Contributing

RestoreWitness is in early development. Discuss substantial changes in an issue first.

## Local checks

Use Node.js 24 or newer. Run `npm ci`, then `npm run check` before opening a pull request.

## Engineering conventions

- Use strict TypeScript; avoid `any` and validate external inputs at runtime.
- Keep orchestration independent from database and storage adapters.
- Add unit tests for behavior and edge cases; use disposable databases for integration tests.
- Never commit credentials, database dumps, or identifiable production data.
- Document supported behavior and limitations as part of each change.
- Keep changes focused and avoid speculative abstractions.
