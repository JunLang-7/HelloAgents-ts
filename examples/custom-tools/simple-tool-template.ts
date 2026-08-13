import { ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';

const tools = new ToolRegistry().registerFunction({
  name: 'ping',
  description: 'Return pong',
  inputSchema: z.object({}).strict(),
  handler: () => 'pong'
});
console.log((await tools.execute('ping', {})).text);
