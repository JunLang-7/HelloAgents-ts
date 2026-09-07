import { expect, test } from 'bun:test';
import fixture from './fixtures/learn-v0.2.0-core.json' with { type: 'json' };
import {
  Agent,
  Config,
  HelloAgentsLLM,
  Message,
  MockAdapter,
  createConfigFromEnv
} from '../hello_agents/index.js';

class FixtureAgent extends Agent {
  public async run(input: string): Promise<string> {
    await this.addMessage(new Message(input, 'user'));
    return input;
  }
}

test('maps the pinned learn_version core models and wire fields', () => {
  const config = new Config();
  expect(config.toDict()).toEqual(fixture.config);
  expect(new Message(fixture.message.content, 'user').toDict()).toEqual({
    role: 'user',
    content: 'hello'
  });
});

test('Config.fromEnv preserves Python environment conversion', () => {
  const config = createConfigFromEnv({
    DEBUG: 'true',
    LOG_LEVEL: 'DEBUG',
    TEMPERATURE: '0.25',
    MAX_TOKENS: '128'
  });
  expect(config.toDict()).toEqual({
    ...fixture.config,
    debug: true,
    log_level: 'DEBUG',
    temperature: 0.25,
    max_tokens: 128
  });
});

test('HelloAgentsLLM auto-detects provider and returns complete text', async () => {
  const llm = new HelloAgentsLLM({
    env: {
      DEEPSEEK_API_KEY: 'deepseek-test-key'
    },
    adapter: new MockAdapter({ invoke: () => fixture.response })
  });

  expect(llm.provider).toBe('deepseek');
  expect(llm.baseUrl).toBe('https://api.deepseek.com');
  expect(llm.model).toBe('deepseek-chat');
  expect(await llm.invoke([{ ...fixture.message, role: 'user' as const }])).toBe('world');
});

test('Agent accepts the Python positional constructor and mutates history', async () => {
  const llm = new HelloAgentsLLM({
    model: 'test-model',
    apiKey: 'test-key',
    baseUrl: 'https://provider.test/v1',
    adapter: new MockAdapter({ invoke: () => fixture.response })
  });
  const agent = new FixtureAgent('fixture-agent', llm);
  await agent.run('hello');
  expect(agent.getHistory().map((message) => message.toDict())).toEqual([
    { role: 'user', content: fixture.message.content }
  ]);
  expect(String(agent)).toBe('Agent(name=fixture-agent, provider=auto)');
});
