import { FunctionTool, ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';

const tool = new FunctionTool({
  name: 'format_code',
  description: 'Trim code lines',
  inputSchema: z.object({ code: z.string() }).strict(),
  handler: ({ code }) =>
    code
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
});
console.log(
  (await new ToolRegistry().register(tool).execute('format_code', { code: '  const x = 1;  ' }))
    .text
);
