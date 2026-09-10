# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/) after its first public release.

## Unreleased

## [0.2.0-learn] - 2026-09-10

### Added

- Teaching-oriented TypeScript port of the Python `learn_version` line at the
  pinned upstream commit `3927c6d1decb37737c4c1344fde00ccef55ab1f3`.
- Core agents and tools, Memory/RAG with optional Qdrant and Neo4j backends,
  context engineering, MCP/A2A/ANP protocols, evaluation, RL helpers, and the
  Chapter 07–11 teaching examples.
- Bun-first and Node.js 22/24 package validation, Python-derived compatibility
  fixtures, explicit subpath exports, and optional-dependency import boundaries.

### Release channel

- Publish as `@junlang-7/helloagents@0.2.0` with npm dist-tag `learn`.
- Keep npm `latest` on the separate production-oriented `1.x` line.

## [1.0.1] - 2026-08-15

### Fixed

- `HelloAgentsLLM` can now be constructed without explicit options; required
  values are read from the `LLM_*` environment variables.

## [1.0.0] - 2026-08-14

### Added

- Bun-first, Node.js 22/24-compatible TypeScript implementation of the
  HelloAgents Python V1.0.0 scope.
- Four agent paradigms, three provider adapters, Zod-based tools, sessions,
  streaming, skills, subagents, tracing, TodoWrite, and DevLog.

## Version policy

- `1.0.0` is the first public TypeScript release compatible with the documented
  Python V1.0.0 behavioural boundary.
- Patch releases fix behaviour without changing the public API or serialized
  contract.
- Minor releases add backwards-compatible APIs or opt-in functionality.
- Major releases may change public APIs, serialized contracts, runtime floors,
  or explicitly expand/revise the Python parity boundary.
- Every release records its source revision, Bun/Node validation results,
  package smoke checks, and compatibility notes in its GitHub release.
