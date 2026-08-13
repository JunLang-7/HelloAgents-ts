# Subagent guide

`TaskTool` runs a child agent with a cloned registry and an optional permission
filter. Build the default factory explicitly:

```ts
import { TaskTool, createAgentFactory } from '@junlang-7/helloagents';

const task = new TaskTool({ agentFactory: createAgentFactory({ llm, toolRegistry: tools }) });
const result = await task.execute({
  task: 'Inspect the read-only workspace',
  agent_type: 'react',
  tool_filter: 'readonly',
  max_steps: 3
});
```

The parent registry and history are never mutated. `readonly` limits access and
`full` explicitly applies the full-access policy; the default `none` value uses
an isolated clone without filtering. Failed child work returns
`partial` metadata instead of throwing through the model-facing tool protocol.
