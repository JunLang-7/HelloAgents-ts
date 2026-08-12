import assert from 'node:assert/strict';

const enabled = process.env.HELLOAGENTS_INTEGRATION === '1';
const required = ['LLM_MODEL_ID', 'LLM_API_KEY', 'LLM_BASE_URL'];
const missing = required.filter((name) => !process.env[name]);

if (!enabled || missing.length > 0) {
  process.stdout.write(
    `Skipping real API integration test (set HELLOAGENTS_INTEGRATION=1 and ${required.join(', ')} to enable).\n`
  );
  process.exit(0);
}

const { HelloAgentsLLM } = await import('../dist/index.js');
const llm = new HelloAgentsLLM({ timeoutMs: 30_000 });
const response = await llm.invoke(
  [{ role: 'user', content: 'Reply with a short greeting for the HelloAgents integration check.' }],
  { temperature: 0, maxTokens: 32 }
);

assert.equal(typeof response.content, 'string');
assert.notEqual(response.content.trim(), '', 'provider must return non-empty content');
process.stdout.write(`Real API integration passed with model ${response.model}.\n`);
