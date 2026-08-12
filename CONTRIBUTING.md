# Contributing to HelloAgents TypeScript

## Scope and compatibility

Python HelloAgents V1.0.0/current `main` is the behavioural authority. Consult
the [compatibility contract](docs/compatibility-contract.md) before changing a
public API, serialized payload, tool schema, lifecycle event, or provider
adapter. HelloAgents-go is a mapping reference, not a competing specification.

## Development workflow

Use Bun 1.3.14 or newer for local development:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun test
bun run build
```

The built package must remain compatible with Node.js 22 and 24 LTS. Run the
Node smoke test after changes to public exports or package metadata:

```sh
bun run test:node
bun run test:package
```

## Changes and pull requests

- Use a conventional branch prefix such as `feat/`, `fix/`, `docs/`, or
  `chore/`; do not use `codex/` or `agents/` prefixes.
- Add or update a focused test with every behavioural change. Start with a
  failing test when practical.
- Keep `Bun.*` APIs behind an explicit runtime adapter; core public types must
  use portable Web/Node-compatible APIs.
- Use Zod schemas for untrusted input and derive Function Calling JSON Schema
  from the same source of truth.
- Give the PR a conventional commit-style title, explain validation, and link
  its Issue with `Closes #<issue>` when it completes that work.
