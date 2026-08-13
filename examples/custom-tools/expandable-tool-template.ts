import { expandableTool, FunctionTool, ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';

const group = expandableTool({
  name: 'text',
  description: 'Text actions',
  tools: [
    new FunctionTool({
      name: 'length',
      description: 'Get length',
      inputSchema: z.object({ text: z.string() }).strict(),
      handler: ({ text }) => text.length
    })
  ]
});
console.log((await new ToolRegistry().register(group).execute('length', { text: 'expand' })).text);
