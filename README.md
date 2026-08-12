# HelloAgents TypeScript

HelloAgents TypeScript is a Bun-first, Node.js-compatible reimplementation of
[HelloAgents Python](https://github.com/jjyaoao/HelloAgents). Python V1.0.0 and
its current `main` branch are the behavioural authority; the Go project is a
cross-language implementation reference.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
node tests/node-smoke.mjs
```

The project targets Bun 1.3.14+ for development and Node.js 22/24 LTS for the
built ESM package. Runtime schemas use Zod 4. See the
[compatibility contract](docs/compatibility-contract.md) for the implementation
boundary and roadmap.

## License and attribution

This is an adaptation of HelloAgents and is distributed under
[CC BY-NC-SA 4.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
