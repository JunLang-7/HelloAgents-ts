# Releasing

The repository is Bun-first and publishes one ESM npm package for Bun and
Node.js 22/24. Before creating a release, run from a clean checkout of the
intended source commit:

```sh
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run format:check
bun test --coverage
bun run fixture:gate && bun run release:gate
bun run build && bun run test:node && bun run test:package
npm pack --dry-run
```

Review the generated archive: it must include `dist/index.js`,
`dist/index.d.ts`, `dist/index.js.map`, `README.md`, `LICENSE`, `NOTICE`, and
`package.json`, but no `hello_agents/` or `tests/` files. `test:package` enforces this
and installs the archive through both `bun add` and `npm install`.

Optionally run a real provider smoke test with a disposable credential:

```sh
HELLOAGENTS_INTEGRATION=1 \
LLM_MODEL_ID=your-model LLM_API_KEY=your-key LLM_BASE_URL=https://provider/v1 \
bun run test:integration
```

## Learn 0.2.0 release procedure

The teaching release is governed by the pinned Python `learn_version` commit
[`3927c6d1`](https://github.com/jjyaoao/HelloAgents/commit/3927c6d1decb37737c4c1344fde00ccef55ab1f3),
the [compatibility matrix](./learn-v0.2.0-compatibility-matrix.md), and the
[approved differences](./upstream-differences.md). It is independent from the
production-oriented `1.x` line.

Before publishing, record and retain the current production tag:

```sh
learn_previous_latest=$(npm view @junlang-7/helloagents dist-tags.latest)
test -n "$learn_previous_latest"
if npm view @junlang-7/helloagents@0.2.0 version; then exit 1; fi
```

The final command must fail with `E404`; an existing `0.2.0` cannot be
overwritten. At the 2026-09-10 release review, `latest` was `1.0.1`; query it
again immediately before publishing rather than assuming that snapshot is
still current.

After CI is green and a maintainer explicitly confirms publication, publish
the exact tested commit. `publishConfig.tag=learn` is a safety boundary, but
the tag is also supplied explicitly for auditability:

```sh
npm whoami
npm publish --tag learn
```

Then verify both selectors from clean temporary consumer projects:

```sh
npm view @junlang-7/helloagents dist-tags --json
npm install @junlang-7/helloagents@0.2.0
npm install @junlang-7/helloagents@learn
```

Both installs must resolve to `0.2.0`, and `dist-tags.latest` must still equal
the recorded `learn_previous_latest`. Create annotated tag `v0.2.0-learn` on that
same source commit, push it, and create the GitHub Release using
[the prepared release notes](./releases/v0.2.0-learn.md). Record the source
branch, full source SHA, npm tarball integrity, and the unchanged `latest`
value in the Release.

Never publish, move a dist-tag, create/push the Git tag, or create the GitHub
Release before that explicit maintainer confirmation.
