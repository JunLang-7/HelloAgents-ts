import { FunctionTool, ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';

const registry = new ToolRegistry();
registry.registerFunction(
  new FunctionTool({
    name: 'word_count',
    description: 'Count whitespace-separated words in text.',
    inputSchema: z.object({ text: z.string() }).strict(),
    handler: ({ text }) => text.trim().split(/\s+/u).filter(Boolean).length
  })
);

console.log(
  (await registry.execute('word_count', { text: 'HelloAgents on Bun and Node' })).toJSON()
);
