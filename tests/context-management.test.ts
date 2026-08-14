import { describe, expect, test } from 'bun:test';

import {
  ContextBuilder,
  HistoryManager,
  ObservationTruncator,
  TokenCounter,
  WorkingMemory
} from '../hello_agents/index.js';
import { Message } from '../hello_agents/core/message.js';

describe('TokenCounter', () => {
  test('caches a replaceable tokenizer and handles Unicode without byte corruption', () => {
    let calls = 0;
    const counter = new TokenCounter({
      tokenize: (text) => {
        calls += 1;
        return [...text].length;
      }
    });

    expect(counter.count('你好🌍')).toBe(3);
    expect(counter.count('你好🌍')).toBe(3);
    expect(calls).toBe(1);
    expect(counter.getStats()).toEqual({ cache_hits: 1, cache_misses: 1, entries: 1 });
    counter.clear();
    expect(counter.getStats().entries).toBe(0);
  });
});

describe('HistoryManager', () => {
  test('compresses whole older user turns while retaining the configured recent turns', async () => {
    const history = new HistoryManager({
      maxTokens: 7,
      retainRecentTurns: 1,
      tokenCounter: new TokenCounter({
        tokenize: (text) => text.split(/\s+/).filter(Boolean).length
      }),
      summarize: (messages) => `summary:${messages.length}`
    });
    history.add(new Message('first question', 'user'));
    history.add(new Message('first answer', 'assistant'));
    history.add(new Message('second question', 'user'));
    history.add(new Message('second answer', 'assistant'));

    const compacted = await history.compact();
    expect(compacted.map((message) => [message.role, message.content])).toEqual([
      ['summary', 'summary:2'],
      ['user', 'second question'],
      ['assistant', 'second answer']
    ]);
  });
});

describe('ObservationTruncator', () => {
  test('stores full output and returns an UTF-8-safe head/tail preview with reason metadata', () => {
    const truncator = new ObservationTruncator({
      maxLines: 3,
      maxBytes: 24,
      headLines: 1,
      tailLines: 1
    });
    const result = truncator.truncate('第一行\n第二行\n第三行\n第四行\n第五行', 'tool-call-1');

    expect(result).toMatchObject({
      truncated: true,
      full_output_id: 'tool-call-1',
      reason: 'line_limit',
      preview: '第一行\n… (输出已截断；完整内容: tool-call-1) …\n第五行'
    });
    expect(truncator.getFullOutput('tool-call-1')).toContain('第四行');
  });

  test('enforces byte limits on Unicode boundaries', () => {
    const truncator = new ObservationTruncator({
      maxLines: 100,
      maxBytes: 60,
      headLines: 1,
      tailLines: 1
    });
    const result = truncator.truncate(
      '你好世界你好世界你好世界你好世界你好世界你好世界',
      'unicode'
    );

    expect(result.truncated).toBe(true);
    expect(result.reason).toBe('byte_limit');
    expect(result.preview.endsWith('世界')).toBe(true);
    expect(new TextEncoder().encode(result.preview).length).toBeLessThanOrEqual(60);
  });
});

describe('WorkingMemory and ContextBuilder', () => {
  test('evicts low-priority/expired items and builds bounded GSSC context', () => {
    let now = 0;
    const memory = new WorkingMemory({
      capacity: 2,
      maxTokens: 20,
      ttlMinutes: 1,
      now: () => now,
      tokenCounter: new TokenCounter({
        tokenize: (text) => text.split(/\s+/).filter(Boolean).length
      })
    });
    memory.add({ id: 'low', content: 'low relevance', importance: 0.1 });
    memory.add({ id: 'high', content: 'important answer', importance: 1 });
    memory.add({ id: 'mid', content: 'middle answer', importance: 0.5 });
    expect(memory.getAll().map((item) => item.id)).toEqual(['high', 'mid']);
    now = 61_000;
    expect(memory.getAll()).toEqual([]);

    const builder = new ContextBuilder({ maxTokens: 40, reserveRatio: 0.25, minRelevance: 0 });
    const context = builder.build({
      userQuery: '中文 查询',
      systemInstructions: '遵守规则',
      conversationHistory: [new Message('旧内容', 'user'), new Message('新内容', 'assistant')],
      additionalPackets: [
        { content: '证据 中文 查询', metadata: { type: 'tool_result' }, relevanceScore: 1 }
      ]
    });
    expect(context).toContain('[Role & Policies]');
    expect(context).toContain('[Task]');
    expect(context).toContain('[Evidence]');
    expect(builder.tokenCounter.count(context)).toBeLessThanOrEqual(30);
  });
});
