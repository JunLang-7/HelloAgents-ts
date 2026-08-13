import { FunctionTool, ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';

const tool = new FunctionTool({
  name: 'upper',
  description: 'Uppercase text',
  inputSchema: z.object({ text: z.string() }).strict(),
  handler: ({ text }) => text.toUpperCase()
});
console.log((await new ToolRegistry().register(tool).execute('upper', { text: 'advanced' })).text);
