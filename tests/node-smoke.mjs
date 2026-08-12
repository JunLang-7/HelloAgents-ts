import assert from 'node:assert/strict';

const packageEntry = await import('../dist/index.js');

assert.equal(packageEntry.version, '0.0.0-development');
assert.equal(packageEntry.metadata.name, '@junlang-7/helloagents');
assert.equal(packageEntry.createConfig().contextWindow, 128_000);
assert.equal(
  packageEntry.Message.fromJSON({
    role: 'user',
    content: 'Node-compatible',
    timestamp: '2026-08-12T12:34:56.123456',
    metadata: {}
  }).toText(),
  '[user] Node-compatible'
);
assert.equal(
  packageEntry.Message.fromJSON({
    role: 'user',
    content: 'x',
    timestamp: '2026-08-12T12:34:56.123456',
    metadata: {}
  }).toJSON().timestamp,
  '2026-08-12T12:34:56.123456'
);
const adapter = new packageEntry.MockAdapter({
  invoke: () => ({ content: 'Node LLM', model: 'test-model', usage: {}, latency_ms: 0 })
});
const llm = new packageEntry.HelloAgentsLLM({
  model: 'test-model',
  apiKey: 'test-key',
  baseUrl: 'https://provider.test',
  adapter
});
assert.equal((await llm.invoke([{ role: 'user', content: 'hello' }])).content, 'Node LLM');
const openAiAdapter = new packageEntry.OpenAIAdapter(
  {
    model: 'test-model',
    apiKey: 'test-key',
    baseUrl: 'https://provider.test/v1',
    timeoutMs: 1000
  },
  async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'Node provider' } }] }), {
      headers: { 'content-type': 'application/json' }
    })
);
assert.equal(
  (await openAiAdapter.invoke({ messages: [{ role: 'user', content: 'hello' }], options: {} }))
    .content,
  'Node provider'
);
