# Configuration

`HelloAgentsLLM` takes explicit options first, then reads the Python-compatible
environment names. It does not load `.env` itself; load it in your Bun or Node
application before constructing the client. Start with the repository
[`.env.example`](../.env.example); it is safe to commit, while `.env` is ignored.

```ts
import { HelloAgentsLLM } from '@junlang-7/helloagents';

const llm = new HelloAgentsLLM({
  model: 'your-model',
  apiKey: process.env.LLM_API_KEY,
  baseUrl: process.env.LLM_BASE_URL,
  timeoutMs: 30_000,
  temperature: 0.2,
  maxTokens: 1024
});
```

| Environment variable | Explicit option | Meaning                                                           |
| -------------------- | --------------- | ----------------------------------------------------------------- |
| `LLM_MODEL_ID`       | `model`         | Model identifier.                                                 |
| `LLM_API_KEY`        | `apiKey`        | Provider credential. Never commit it.                             |
| `LLM_BASE_URL`       | `baseUrl`       | Provider API base URL.                                            |
| `LLM_TIMEOUT`        | `timeoutMs`     | Timeout in seconds in the environment, milliseconds as an option. |

Adapter selection follows `baseUrl`: OpenAI-compatible is the default;
`anthropic.com` selects Anthropic and `googleapis.com` or
`generativelanguage` selects Gemini. An injected `adapter` or `adapterFactory`
is useful for tests and non-standard providers.

Framework defaults are created with `createConfig()`. Use camelCase in
TypeScript options (`maxConcurrentTools`, `sessionDir`, `skillsDir`); the
serialized compatibility payload is intentionally snake_case. The complete
contract is in [compatibility-contract.md](compatibility-contract.md).
