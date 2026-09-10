/**
 * 最简 FunctionCallAgent 示例（对应上游 examples/agent/function_call_agent_demo.py）。
 *
 * 默认使用 mock LLM（dry-run，无需任何 API Key）：mock 第一轮返回结构化
 * tool_call，Agent 真正执行注册的 get_horoscope，第二轮返回最终回答。
 * 设置 OPENAI_API_KEY 或 HELLOAGENTS_REAL_API=1 后改用真实 OpenAI 兼容接口。
 *
 * 运行：bun run examples/function-call-agent-demo.ts
 */
import { FunctionCallAgent } from '../hello_agents/agents/index.js';
import { HelloAgentsLLM } from '../hello_agents/core/index.js';
import { ToolRegistry, FunctionTool } from '../hello_agents/tools/index.js';
import { z } from 'zod';
import { heading, mockLlmWithTools } from './_shared.js';

function getHoroscope(sign: string): string {
  const sample: Record<string, string> = {
    白羊座: '保持耐心，合作能带来额外好运。',
    金牛座: '适合整理计划，财务上保持谨慎。',
    双子座: '沟通顺畅，适合推进新想法。',
    巨蟹座: '关注家人需求，情绪管理很重要。'
  };
  return sample[sign.trim()] ?? '今天以平静面对生活，一切都会慢慢变好。';
}

const USE_REAL_API =
  process.env.HELLOAGENTS_REAL_API === '1' || Boolean(process.env.OPENAI_API_KEY);

function buildLlm(): HelloAgentsLLM {
  if (USE_REAL_API) {
    return new HelloAgentsLLM({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' });
  }
  // mock/dry-run：第一轮返回结构化 tool_call，第二轮返回最终回答
  return mockLlmWithTools([
    { toolCall: { name: 'get_horoscope', arguments: '{"sign":"金牛座"}' } },
    '根据工具结果回答用户。'
  ]);
}

async function main(): Promise<void> {
  heading('最简 FunctionCallAgent（上游 function_call_agent_demo.py 对应）');
  console.log(`模式: ${USE_REAL_API ? '真实 API' : 'mock / dry-run'}`);

  const llm = buildLlm();

  let horoscopeCalls = 0;
  const registry = new ToolRegistry();
  registry.registerFunction(
    new FunctionTool({
      name: 'get_horoscope',
      description: "Get today's horoscope for an astrological sign.",
      inputSchema: z.object({ sign: z.string() }).strict(),
      handler: ({ sign }) => {
        horoscopeCalls += 1;
        return getHoroscope(sign);
      }
    })
  );

  const agent = new FunctionCallAgent({
    name: 'demo-agent',
    llm,
    toolRegistry: registry
  });

  const question = '请告诉我金牛座今天的运势，并说明是如何得到信息的。';
  const answer = await agent.run(question);
  console.log('Agent:', answer);
  console.log(`get_horoscope 实际执行次数: ${horoscopeCalls}`);
}

void main();
