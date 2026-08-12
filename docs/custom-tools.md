# Custom tools

Use a strict Zod object as a tool's single input contract. The registry derives
the Function Calling schema from it and `Tool.execute()` returns the standard
structured `ToolResponse`.

```ts
import { FunctionTool, ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';

const registry = new ToolRegistry().registerFunction({
  name: 'word_count',
  description: 'Count whitespace-separated words.',
  inputSchema: z.object({ text: z.string() }).strict(),
  handler: ({ text }) => text.trim().split(/\s+/u).filter(Boolean).length
});

const response = await registry.execute('word_count', { text: 'HelloAgents is portable' });
console.log(response.toJSON().data.output); // 3
```

For stateful tools, subclass `Tool<typeof YourTool.inputSchema>` and implement
`protected run(input)`. Validate runtime data with Zod, return
`ToolResponse.error(...)` for model-recoverable failures, and throw typed
framework errors only for invalid framework configuration. Do not hand-write a
second provider JSON schema unless the Zod schema cannot be represented.

See [examples/custom-tool.ts](../examples/custom-tool.ts) for a runnable file.
