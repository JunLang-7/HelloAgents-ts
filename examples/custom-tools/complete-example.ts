import { ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';

const tools = new ToolRegistry().registerFunction({
  name: 'greet',
  description: 'Greet a person',
  inputSchema: z.object({ name: z.string() }).strict(),
  handler: ({ name }) => `Hello, ${name}!`
});
console.log((await tools.execute('greet', { name: 'TypeScript' })).toJSON());
