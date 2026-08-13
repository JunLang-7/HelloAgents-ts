import { createAgentFactory, TaskTool, ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';
import { heading, mockLlm } from './_shared.js';

heading('subagent');
const tools = new ToolRegistry().registerFunction({
  name: 'workspace_info',
  description: 'Return a fixed workspace label',
  inputSchema: z.object({}).strict(),
  handler: () => 'demo workspace'
});
const task = new TaskTool({
  agentFactory: createAgentFactory({ llm: mockLlm(), toolRegistry: tools })
});
console.log(
  (
    await task.execute({
      task: 'Inspect the workspace',
      agent_type: 'simple',
      tool_filter: 'readonly'
    })
  ).text
);
