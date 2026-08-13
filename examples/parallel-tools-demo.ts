import { FunctionTool, ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';
import { heading } from './_shared.js';

heading('parallel tools');
const tools = new ToolRegistry();
for (const name of ['one', 'two', 'three']) {
  tools.registerFunction(
    new FunctionTool({
      name,
      description: `Return ${name}`,
      inputSchema: z.object({}).strict(),
      handler: () => name
    })
  );
}
const results = await Promise.all(['one', 'two', 'three'].map((name) => tools.execute(name, {})));
console.log(results.map((result) => result.text));
