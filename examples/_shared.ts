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

export function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}
