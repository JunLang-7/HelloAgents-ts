# Async agent guide

All agent execution is Promise-based. Create an agent with a configured
`HelloAgentsLLM`, then await `run`:

```ts
import { HelloAgentsLLM, SimpleAgent } from '@junlang-7/helloagents';

const llm = new HelloAgentsLLM({
  model: process.env.LLM_MODEL_ID!,
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: process.env.LLM_BASE_URL!
});
const agent = new SimpleAgent({ name: 'assistant', llm });
console.log(await agent.run('Summarize the release notes.'));
```

Use `arun` when lifecycle hooks or an `AbortSignal` are needed. The native
`ainvoke` and `ainvokeWithTools` methods are aliases for the Promise-first LLM
methods; no blocking API is required in TypeScript.
