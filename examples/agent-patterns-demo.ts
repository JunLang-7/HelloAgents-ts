import {
  FunctionTool,
  HelloAgentsLLM,
  MockAdapter,
  PlanAndSolveAgent,
  ReActAgent,
  ReflectionAgent,
  ToolRegistry
} from '@junlang-7/helloagents';
import { z } from 'zod';

const config = { model: 'demo-model', apiKey: 'demo-key', baseUrl: 'https://provider.test' };

function mockLlm(replies: string[]): HelloAgentsLLM {
  return new HelloAgentsLLM({
    ...config,
    adapter: new MockAdapter({
      invoke: () => ({
        content: replies.shift() ?? '',
        model: 'demo-model',
        usage: {},
        latency_ms: 0
      })
    })
  });
}

const tools = new ToolRegistry().registerFunction(
  new FunctionTool({
    name: 'echo',
    description: 'Repeat a string.',
    inputSchema: z.object({ input: z.string() }).strict(),
    handler: ({ input }) => input
  })
);
const react = new ReActAgent({
  name: 'react-demo',
  llm: mockLlm(['Thought: repeat it\nAction: echo[hello]', 'Action: Finish[hello]']),
  toolRegistry: tools
});
console.log('ReAct:', await react.run('Repeat hello.'));

const reflection = new ReflectionAgent({
  name: 'reflection-demo',
  llm: mockLlm(['draft', 'make it clearer', 'clear draft', '无需改进'])
});
console.log('Reflection:', await reflection.run('Write a greeting.'));

const planAndSolve = new PlanAndSolveAgent({
  name: 'plan-demo',
  llm: mockLlm([
    '```python\n["find the value", "state the answer"]\n```',
    '42',
    'The answer is 42.'
  ])
});
console.log('Plan-and-solve:', await planAndSolve.run('What is the answer?'));
