import { HelloAgentsLLM, MockAdapter } from '@junlang-7/helloagents';

export function mockLlm(responses: readonly string[] = ['mock answer']): HelloAgentsLLM {
  let index = 0;
  return new HelloAgentsLLM({
    model: 'example-model',
    apiKey: 'example-key',
    baseUrl: 'https://example.invalid/v1',
    adapter: new MockAdapter({
      invoke: () => ({
        content: responses[Math.min(index++, responses.length - 1)] ?? '',
        model: 'example-model',
        usage: { total_tokens: 1 },
        latency_ms: 0
      }),
      invokeWithTools: () => ({
        content: responses[Math.min(index++, responses.length - 1)] ?? '',
        tool_calls: [],
        model: 'example-model',
        usage: { total_tokens: 1 },
        latency_ms: 0
      })
    })
  });
}

/** 一轮结构化工具调用：返回给模型的 tool_call，之后会真正执行注册的工具。 */
export interface MockToolCallStep {
  readonly toolCall: { readonly name: string; readonly arguments: string };
  readonly content?: string | null;
}

/**
 * 支持工具执行的 mock LLM。字符串步骤返回纯文本；{@link MockToolCallStep}
 * 步骤返回结构化 tool_call（由 Agent 层执行对应工具后再进入下一步）。
 */
export function mockLlmWithTools(steps: readonly (string | MockToolCallStep)[]): HelloAgentsLLM {
  let index = 0;
  const next = (): string | MockToolCallStep =>
    steps[Math.min(index, steps.length - 1)] ?? 'mock answer';
  return new HelloAgentsLLM({
    model: 'example-model',
    apiKey: 'example-key',
    baseUrl: 'https://example.invalid/v1',
    adapter: new MockAdapter({
      invoke: () => {
        const step = next();
        index += 1;
        return {
          content: typeof step === 'string' ? step : (step.content ?? ''),
          model: 'example-model',
          usage: { total_tokens: 1 },
          latency_ms: 0
        };
      },
      invokeWithTools: () => {
        const step = next();
        index += 1;
        const isCall = typeof step !== 'string';
        return isCall
          ? {
              content: (step as MockToolCallStep).content ?? null,
              tool_calls: [
                {
                  id: `call_${index}`,
                  name: (step as MockToolCallStep).toolCall.name,
                  arguments: (step as MockToolCallStep).toolCall.arguments
                }
              ],
              model: 'example-model',
              usage: { total_tokens: 1 },
              latency_ms: 0
            }
          : {
              content: step,
              tool_calls: [],
              model: 'example-model',
              usage: { total_tokens: 1 },
              latency_ms: 0
            };
      }
    })
  });
}

export function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}
