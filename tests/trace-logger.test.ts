import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HelloAgentsLLM,
  MockAdapter,
  SimpleAgent,
  TraceLogger,
  createTraceHooks,
  traceEventSchema,
  withTraceFinalization
} from '../hello_agents/index.js';

describe('TraceLogger', () => {
  test('writes validated JSONL events and an HTML report with Go-compatible statistics', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'helloagents-trace-'));
    try {
      const logger = await TraceLogger.create({ outputDir, sanitize: false });
      await logger.logEvent('session_start', { agent_name: 'tester' });
      await logger.logEvent('tool_call', { tool_name: 'Read' }, 1);
      await logger.logEvent('tool_call', {}, 2);
      await logger.logEvent('model_output', { usage: { total_tokens: 12, cost: 0.5 } }, 3);
      await logger.logEvent('error', { error_type: 'ToolError', message: 'boom' }, 2);
      await logger.logEvent('session_end', {});
      const stats = await logger.finalize();

      expect(stats).toMatchObject({
        total_steps: 3,
        total_tokens: 12,
        total_cost: 0.5,
        model_calls: 1,
        tool_calls: { Read: 1, unknown: 1 },
        errors: [{ step: 2, type: 'ToolError', message: 'boom' }]
      });
      const lines = (await readFile(logger.jsonlPath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(6);
      expect(traceEventSchema.parse(JSON.parse(lines[0] ?? '{}'))).toMatchObject({
        session_id: logger.sessionId,
        event: 'session_start',
        step: null
      });
      const html = await readFile(logger.htmlPath, 'utf8');
      expect(html).toContain('Trace Session');
      expect(html).toContain('total_tokens');
      expect(html).toContain('tool_call');
      await expect(logger.logEvent('ignored', {})).resolves.toBeUndefined();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('redacts secret keys, tokens, home paths, and raw responses by default', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'helloagents-trace-'));
    try {
      const logger = await TraceLogger.create({ outputDir });
      await logger.logEvent('model_output', {
        api_key: 'sk-secret123',
        authorization: 'Bearer abc_def-123',
        nested: { token: 'private-token', path: '/Users/jane/project' },
        raw_response: 'the original provider reply'
      });
      await logger.finalize();
      const trace = await readFile(logger.jsonlPath, 'utf8');
      expect(trace).not.toContain('secret123');
      expect(trace).not.toContain('abc_def-123');
      expect(trace).not.toContain('private-token');
      expect(trace).not.toContain('/Users/jane');
      expect(trace).not.toContain('the original provider reply');
      expect(trace).toContain('[REDACTED]');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('supports raw-response opt-in while keeping credentials redacted and finalizes after errors', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'helloagents-trace-'));
    try {
      const logger = await TraceLogger.create({ outputDir, includeRawResponse: true });
      const hooks = createTraceHooks(logger);
      await hooks.message({ role: 'user', content: 'hello' });
      await hooks.model({ raw_response: 'visible response', api_key: 'sk-still-secret' }, 1);
      await expect(
        withTraceFinalization(logger, async () => {
          throw new Error('expected failure');
        })
      ).rejects.toThrow('expected failure');
      const trace = await readFile(logger.jsonlPath, 'utf8');
      expect(trace).toContain('visible response');
      expect(trace).not.toContain('still-secret');
      expect(await readFile(logger.htmlPath, 'utf8')).toContain('Trace Session');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('normalizes invalid trace inputs and makes concurrent finalization idempotent', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'helloagents-trace-'));
    try {
      const logger = await TraceLogger.create({ outputDir });
      await expect(logger.logEvent('', {})).rejects.toThrow('Invalid TraceEvent');
      await logger.logEvent('session_start', {});
      const [first, second] = await Promise.all([logger.finalize(), logger.finalize()]);
      expect(first).toEqual(second);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test('instruments a complete SimpleAgent run and finalizes both outputs', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'helloagents-trace-'));
    try {
      const logger = await TraceLogger.create({ outputDir });
      const agent = new SimpleAgent({
        name: 'traced-agent',
        traceLogger: logger,
        llm: new HelloAgentsLLM({
          model: 'test-model',
          apiKey: 'test-key',
          baseUrl: 'https://provider.test',
          adapter: new MockAdapter({
            invoke: () => ({ content: 'answer', model: 'test-model', usage: {}, latency_ms: 0 })
          })
        })
      });
      await expect(agent.run('hello')).resolves.toBe('answer');
      const events = (await readFile(logger.jsonlPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string });
      expect(events.map((event) => event.event)).toEqual([
        'session_start',
        'message_written',
        'model_output',
        'session_end'
      ]);
      expect((events[2] as { payload?: { model?: string } } | undefined)?.payload).toMatchObject({
        model: 'test-model'
      });
      expect(await readFile(logger.htmlPath, 'utf8')).toContain('Trace Session');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
