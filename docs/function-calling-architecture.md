# Function Calling architecture

Tools use a Zod object schema as the single input authority. The registry
validates inputs, derives provider JSON Schema, and returns `ToolResponse`:

```ts
import { z } from 'zod';
import { FunctionTool, ToolRegistry } from '@junlang-7/helloagents';

const tools = new ToolRegistry().registerFunction({
  name: 'add',
  description: 'Add two numbers',
  inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
  handler: ({ a, b }) => a + b
});
const schemas = tools.toOpenAISchemas();
const result = await tools.execute('add', '{"a": 2, "b": 3}');
```

Provider adapters normalize tool calls while retaining the JSON-string
`arguments` and original `tool_call_id`. Invalid parameters become a readable
`INVALID_PARAM` response instead of an uncaught exception.
