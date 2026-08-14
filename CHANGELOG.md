# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/) after its first public release.

## Unreleased

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
