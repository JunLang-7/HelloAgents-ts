# CI and real integration evidence

The default CI workflow (`.github/workflows/ci.yml`) runs on pull requests and on
pushes to `learn-version` and `main`. Its quality and package checks use the
repository's tests only: they do not receive credentials, call a real API, train,
or publish a package. Installing dependencies is the only normal external network
operation.

## Opt-in real API evidence

Real API evidence is deliberately separate from pull-request CI. A repository
maintainer can run **Actions → Opt-in integration evidence → Run workflow** only
on the `learn-version` branch, select `RUN_REAL_INTEGRATION` for the confirmation
input, and optionally provide the backend/endpoint version. The workflow rejects
other dispatch refs before any secret-capable job can run. After that check, the
real API job checks out the immutable dispatch commit (`github.sha`), not the
mutable branch tip. Its checkout and Bun setup actions are pinned to reviewed
full commit SHAs. It has `contents: read` permission and contains no
package-publish step.

One-time repository setup:

1. Create an Actions environment named `integration`.
2. Require reviewer approval for that environment.
3. Add these **environment secrets** (not pull-request or repository variables):
   `LLM_MODEL_ID`, `LLM_API_KEY`, and `LLM_BASE_URL`.

The workflow first checks that all three secrets are present without printing
values. If any are absent, the real API job is marked **skipped**, not passed.
After approval and configuration, it runs `bun run test:integration`, which builds
the package and invokes `tests/real-api-opt-in.mjs`. The test reports only a safe
skip or pass/fail status: it never prints the model identifier, response content,
credentials, or provider error details. Live failures retain a non-zero exit
status while emitting only a generic redacted message. The run summary records
the checked-out commit SHA, the supplied backend version (or `not provided`), the
command, and a redacted result. This is evidence for the configured API endpoint
only, not proof of real database, protocol, reinforcement-learning, or other
backends.
