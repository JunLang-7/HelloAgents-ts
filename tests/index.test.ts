import { describe, expect, test } from 'bun:test';

import { metadata, version } from '../hello_agents/index.js';

describe('package entry point', () => {
  test('exposes development metadata without a Bun-specific public type', () => {
    expect(version).toBe('0.0.0-development');
    expect(metadata).toEqual({
      name: '@junlang-7/helloagents',
      upstream: 'https://github.com/jjyaoao/HelloAgents',
      license: 'CC-BY-NC-SA-4.0'
    });
  });
});
