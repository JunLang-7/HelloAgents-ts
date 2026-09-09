import { describe, expect, test } from 'bun:test';

import {
  ContextBuilder,
  ContextConfig,
  ContextPacket,
  HistoryManager,
  ObservationTruncator,
  TokenCounter,
  countTokens
} from '../hello_agents/index.js';
import type { MemoryToolLike, RagToolLike } from '../hello_agents/index.js';
import { WorkingMemory } from '../hello_agents/context/working-memory.js';
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
      ['system', 'summary:2'],
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

describe('WorkingMemory', () => {
  test('evicts low-priority/expired items', () => {
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
  });
});

describe('ContextPacket / ContextConfig / countTokens (upstream-aligned)', () => {
  test('ContextPacket auto-computes token_count via countTokens when not supplied', () => {
    const packet = new ContextPacket('abcdefgh'); // 8 字符 → 2 token
    expect(packet.token_count).toBe(2);
    expect(packet.metadata).toEqual({});
    expect(packet.relevance_score).toBe(0);
    expect(packet.timestamp).toBeInstanceOf(Date);
  });

  test('ContextPacket keeps an explicitly supplied token_count', () => {
    const packet = new ContextPacket('very long content', undefined, {}, 99);
    expect(packet.token_count).toBe(99);
  });

  test('ContextConfig defaults match upstream and getAvailableTokens reserves the ratio', () => {
    const config = new ContextConfig();
    expect(config.max_tokens).toBe(8000);
    expect(config.reserve_ratio).toBe(0.15);
    expect(config.min_relevance).toBe(0.3);
    expect(config.enable_mmr).toBe(true);
    expect(config.mmr_lambda).toBe(0.7);
    expect(config.system_prompt_template).toBe('');
    expect(config.enable_compression).toBe(true);
    expect(config.getAvailableTokens()).toBe(6800);
    expect(new ContextConfig({ max_tokens: 100, reserve_ratio: 0.5 }).getAvailableTokens()).toBe(
      50
    );
  });

  test('countTokens uses the 4-chars-per-token estimate (upstream fallback)', () => {
    expect(countTokens('abcdefgh')).toBe(2);
    expect(countTokens('')).toBe(0);
  });
});

describe('ContextBuilder GSSC stages (upstream-aligned)', () => {
  const instructions = '遵守规则';
  const now = new Date();

  test('_gather collects system instructions, history and additional packets without tools', async () => {
    const builder = new ContextBuilder();
    const packets = await builder._gather(
      'user query',
      [new Message('旧内容', 'user'), new Message('新内容', 'assistant')],
      instructions,
      [new ContextPacket('extra', undefined, { type: 'tool_result' })]
    );
    expect(packets.map((p) => p.metadata['type'])).toEqual([
      'instructions',
      'history',
      'tool_result'
    ]);
    expect(packets[1]!.content).toBe('[user] 旧内容\n[assistant] 新内容');
    expect(packets[1]!.metadata['count']).toBe(2);
  });

  test('_gather injects task_state and related_memory from MemoryToolLike', async () => {
    const memoryTool: MemoryToolLike = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      searchMemory: (query?: string, _limit = 5, _type?: string, minImportance = 0.1) =>
        query?.includes('任务状态')
          ? '找到任务状态：步骤 2 完成'
          : minImportance >= 0.7
            ? '重要记忆结果'
            : `相关记忆：${query}`
    };
    const builder = new ContextBuilder(memoryTool);
    const packets = await builder._gather('查询', [], undefined, []);
    const types = packets.map((p) => p.metadata['type']);
    expect(types).toContain('task_state');
    expect(types).toContain('related_memory');
    expect(packets[0]!.metadata['importance']).toBe('high');
  });

  test('_gather skips memory results that report 未找到', async () => {
    const memoryTool: MemoryToolLike = {
      searchMemory: () => `🔍 未找到与 'x' 相关的记忆`
    };
    const builder = new ContextBuilder(memoryTool);
    const packets = await builder._gather('查询', [], undefined, []);
    expect(packets).toEqual([]);
  });

  test('_gather injects knowledge_base from RagToolLike (async)', async () => {
    const ragTool: RagToolLike = {
      search: async (input) => ({ text: `引用：[doc1] ${input.query} 相关事实` })
    };
    const builder = new ContextBuilder(undefined, ragTool);
    const packets = await builder._gather('查询', [], undefined, []);
    expect(packets.map((p) => p.metadata['type'])).toEqual(['knowledge_base']);
  });

  test('_gather skips RAG results that report 未找到 or 错误', async () => {
    const ragTool: RagToolLike = {
      search: async () => ({ text: `🔍 未找到与「x」相关的内容` })
    };
    const builder = new ContextBuilder(undefined, ragTool);
    expect(await builder._gather('查询', [], undefined, [])).toEqual([]);
    const errorRag: RagToolLike = {
      search: async () => ({ text: '❌ 错误: 服务不可用' })
    };
    const errorBuilder = new ContextBuilder(undefined, errorRag);
    expect(await errorBuilder._gather('查询', [], undefined, [])).toEqual([]);
  });

  test('_select computes relevance as keyword overlap and orders by composite score', () => {
    const builder = new ContextBuilder(
      undefined,
      undefined,
      new ContextConfig({ min_relevance: 0.01 })
    );
    const packets = [
      new ContextPacket('hello world content', now, { type: 'history' }),
      new ContextPacket('unrelated stuff here', now, { type: 'history' }),
      new ContextPacket('hello shared', now, { type: 'tool_result' })
    ];
    const selected = builder._select(packets, 'hello world');
    // 相关性：packet0 = 2/2 = 1.0；packet2 = 1/2 = 0.5；packet1 = 0
    expect(packets[0]!.relevance_score).toBe(1);
    expect(packets[2]!.relevance_score).toBe(0.5);
    expect(packets[1]!.relevance_score).toBe(0);
    // 同为 now 时 recency 相同，排序按分数降序：packet0, packet2（packet1 被 min_relevance 过滤）
    expect(selected.map((p) => p.content)).toEqual(['hello world content', 'hello shared']);
  });

  test('_select keeps instructions regardless of relevance and honors budget', () => {
    const builder = new ContextBuilder(
      undefined,
      undefined,
      new ContextConfig({ min_relevance: 0 })
    );
    const packets = [
      new ContextPacket('irrelevant text', now, { type: 'tool_result' }), // rel 0
      new ContextPacket('系统指令内容', now, { type: 'instructions' })
    ];
    const selected = builder._select(packets, 'zzz');
    expect(selected.map((p) => p.metadata['type'])).toEqual(['instructions', 'tool_result']);
  });

  test('_select stops filling once the token budget is exhausted', () => {
    const builder = new ContextBuilder(
      undefined,
      undefined,
      new ContextConfig({ max_tokens: 40, reserve_ratio: 0.5, min_relevance: 0 })
    );
    const packet = new ContextPacket('x'.repeat(200), now); // 50 token > 20
    const small = new ContextPacket('y'.repeat(40), now); // 10 token
    const selected = builder._select([packet, small], 'query');
    expect(selected).toEqual([small]);
  });

  test('_structure renders the upstream section template', () => {
    const builder = new ContextBuilder();
    const context = builder._structure(
      [
        new ContextPacket('指令内容', now, { type: 'instructions' }),
        new ContextPacket('任务状态内容', now, { type: 'task_state' }),
        new ContextPacket('证据内容', now, { type: 'knowledge_base' }),
        new ContextPacket('历史内容', now, { type: 'history' })
      ],
      '用户问题',
      '指令内容'
    );
    expect(context).toContain('[Role & Policies]\n指令内容');
    expect(context).toContain('[Task]\n用户问题：用户问题');
    expect(context).toContain('[State]\n关键进展与未决问题：\n任务状态内容');
    expect(context).toContain('[Evidence]\n事实与引用：\n\n证据内容\n');
    expect(context).toContain('[Context]\n对话历史与背景：\n历史内容');
    expect(context).toContain('[Output]');
  });

  test('_compress truncates by line when over budget and skips when disabled', () => {
    const builder = new ContextBuilder(
      undefined,
      undefined,
      new ContextConfig({ max_tokens: 100, reserve_ratio: 0.5 }) // available = 50
    );
    const longContext = Array.from({ length: 10 }, (_, i) => `line-${i}: ${'字'.repeat(30)}`).join(
      '\n'
    );
    expect(countTokens(longContext)).toBeGreaterThan(50);
    const compressed = builder._compress(longContext);
    expect(compressed).not.toContain('line-9');
    expect(compressed.startsWith('line-0')).toBe(true);
    expect(countTokens(compressed)).toBeLessThanOrEqual(50);

    const raw = new ContextBuilder(
      undefined,
      undefined,
      new ContextConfig({ enable_compression: false })
    );
    expect(raw._compress(longContext)).toBe(longContext);
  });

  test('build runs the full GSSC pipeline with MemoryToolLike and RagToolLike', async () => {
    const memoryTool: MemoryToolLike = {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      searchMemory: (query?: string, _limit = 5, _type?: string, _minImportance = 0.1) =>
        query?.includes('任务状态') ? '任务状态：模块 A 完成' : '相关记忆：用户偏好确定性测试'
    };
    const ragTool: RagToolLike = {
      search: async (input) => ({ text: `引用：关于「${input.query}」的事实证据` })
    };
    const builder = new ContextBuilder(
      memoryTool,
      ragTool,
      new ContextConfig({ max_tokens: 2000, min_relevance: 0 })
    );
    const context = await builder.build(
      'user query',
      [new Message('最近消息', 'user')],
      '系统指令',
      [new ContextPacket('额外事实', undefined, { type: 'tool_result' })]
    );
    expect(context).toContain('[Role & Policies]');
    expect(context).toContain('[Task]\n用户问题：user query');
    expect(context).toContain('[State]');
    expect(context).toContain('[Evidence]');
    expect(context).toContain('[Context]');
    expect(context).toContain('相关记忆');
    expect(context).toContain('事实证据');
  });
});

describe('ContextBuilder 1.x compatibility contract', () => {
  test('legacy options constructor + sync build returns a string (guide pattern)', () => {
    const history = new HistoryManager({ maxTokens: 4096, retainRecentTurns: 2 });
    history.add(new Message('Earlier answer', 'assistant'));
    history.add(new Message('New question', 'user'));
    const context = new ContextBuilder({ maxTokens: 4096 }).build({
      systemInstructions: 'Answer concisely.',
      conversationHistory: history.getAll(),
      userQuery: 'New question'
    });
    expect(typeof context).toBe('string');
    expect(context).toContain('[Role & Policies]\nAnswer concisely.');
    expect(context).toContain('[Task]\n用户问题：New question');
    expect(context).toContain('[Context]\n对话历史与背景：');
    expect(context).toContain('[Output]');
    expect(context).toContain('1. 结论（简洁明确）');
  });

  test('injected TokenCounter drives the legacy budget and compresses', () => {
    let calls = 0;
    const counter = new TokenCounter({
      tokenize: (text) => {
        calls += 1;
        return Math.floor([...text].length / 4);
      }
    });
    const builder = new ContextBuilder({ maxTokens: 32, tokenCounter: counter });
    const context = builder.build({
      userQuery: 'q',
      systemInstructions: 'Be concise.',
      additionalPackets: [
        { content: 'packet one', metadata: { type: 'tool_result' }, relevanceScore: 0.9 }
      ]
    });
    expect(calls).toBeGreaterThan(0);
    expect(context).toContain('1. 结论');
    expect(context).not.toContain('4. 下一步行动建议');
  });

  test('legacy build accepts 1.x-shaped packets (ContextPacketLike) and filters by relevance', () => {
    const builder = new ContextBuilder({});
    const context = builder.build({
      userQuery: 'shared',
      additionalPackets: [
        {
          content: 'shared fact',
          metadata: { type: 'tool_result' },
          timestamp: Date.now(),
          tokenCount: 2,
          relevanceScore: 0.8
        },
        { content: 'unrelated note', metadata: { type: 'related_memory' } }
      ]
    });
    expect(context).toContain('[Evidence]');
    expect(context).toContain('shared fact');
    expect(context).not.toContain('unrelated note');
  });

  test('upstream positional constructor and legacy options constructor coexist', async () => {
    const upstream = new ContextBuilder(
      undefined,
      undefined,
      new ContextConfig({ max_tokens: 100 })
    );
    expect(upstream.config.max_tokens).toBe(100);
    expect(upstream.memory_tool).toBeUndefined();
    const legacy = new ContextBuilder({ maxTokens: 200 });
    expect(legacy.config.max_tokens).toBe(200);
    const result = await upstream.build('q');
    expect(typeof result).toBe('string');
  });
});
