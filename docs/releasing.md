# Releasing

The repository is Bun-first and publishes one ESM npm package for Bun and
Node.js 22/24. Before creating a release, run:

```sh
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run format:check
bun test --coverage
bun run build && bun run test:node && bun run test:package
npm pack --dry-run
```

Review the generated archive: it must include `dist/index.js`,
`dist/index.d.ts`, `dist/index.js.map`, `README.md`, `LICENSE`, `NOTICE`, and
`package.json`, but no `src/` or `tests/` files. `test:package` enforces this
and installs the archive through both `bun add` and `npm install`.

Optionally run a real provider smoke test with a disposable credential:

```sh
HELLOAGENTS_INTEGRATION=1 \
LLM_MODEL_ID=your-model LLM_API_KEY=your-key LLM_BASE_URL=https://provider/v1 \
bun run test:integration
```

Then update [CHANGELOG.md](../CHANGELOG.md), set the release version, tag the
commit, and publish only after CI is green. See the version policy in the
changelog; Python V1.0.0/current `main` remains the behavioural authority.
