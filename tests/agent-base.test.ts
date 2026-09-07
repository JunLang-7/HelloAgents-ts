import { describe, expect, test } from 'bun:test';

import { Agent, HelloAgentsLLM, Message, MockAdapter } from '../hello_agents/index.js';

class TestAgent extends Agent {
  public async run(input: string): Promise<string> {
    return input;
  }
}

describe('Agent base behavior', () => {
  test('keeps append-only history and returns a defensive copy', () => {
    const agent = new TestAgent(
      'base',
      new HelloAgentsLLM({
        model: 'test',
        apiKey: 'key',
        baseUrl: 'https://provider.test',
        adapter: new MockAdapter()
      })
    );
    agent.addMessage(new Message('first question', 'user'));
    const history = agent.getHistory();
    expect(history.map((message) => message.content)).toEqual(['first question']);
    history.length = 0;
    expect(agent.getHistory()).toHaveLength(1);
    agent.clearHistory();
    expect(agent.getHistory()).toEqual([]);
  });
});
