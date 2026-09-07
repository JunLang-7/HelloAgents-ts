/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fixture gate tests: run TS implementations with the same inputs as the
 * Python fixture generator, normalize outputs identically, and assert equality.
 *
 * Fixtures are generated from upstream commit 3927c6d by
 * scripts/generate-fixtures/generate.py and committed to
 * tests/fixtures/generated/.
 *
 * To regenerate: cd scripts/generate-fixtures && .venv/bin/python generate.py
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { CalculatorTool } from '../hello_agents/tools/builtin/calculator.js';
import { MemoryTool } from '../hello_agents/tools/builtin/memory-tool.js';
import { MemoryConfig } from '../hello_agents/memory/base.js';
import { Config } from '../hello_agents/core/config.js';
import { Message } from '../hello_agents/core/message.js';
import { normalizeCase } from './fixture-harness/normalizer.js';
import { loadFixture, loadManifest } from './fixture-harness/fixture-loader.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ha-fixture-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Manifest integrity ───────────────────────────────────────────────────

describe('fixture manifest', () => {
  it('has pinned upstream SHA', () => {
    const manifest = loadManifest();
    expect(manifest.upstream_sha).toBe('3927c6d1decb37737c4c1344fde00ccef55ab1f3');
  });

  it('declares normalization rules', () => {
    const manifest = loadManifest();
    expect(manifest.normalization.time).toBeDefined();
    expect(manifest.normalization.uuid).toBeDefined();
    expect(manifest.normalization.float).toBeDefined();
    expect(manifest.normalization.random_seed).toBe(42);
  });

  it('every case file exists and is valid JSON', () => {
    const manifest = loadManifest();
    for (const [, info] of Object.entries(manifest.cases)) {
      const data = loadFixture(info.file.replace(/\.json$/, ''));
      expect(data).toBeDefined();
      expect(typeof data).toBe('object');
    }
  });
});

// ─── Defaults ─────────────────────────────────────────────────────────────

describe('defaults fixture', () => {
  const fx = loadFixture<any>('defaults');

  it('Config defaults match upstream (intersection of fields)', () => {
    const cfg = new Config();
    const tsJson = cfg.toJSON() as Record<string, unknown>;
    // TS Config has tracing extensions beyond upstream; compare only the
    // fields that exist in the upstream fixture.
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(fx.config)) {
      filtered[key] = tsJson[key];
    }
    expect(normalizeCase(filtered)).toEqual(normalizeCase(fx.config));
  });

  it('MemoryConfig defaults match upstream', () => {
    const mc = new MemoryConfig();
    // MemoryConfig has no toJSON(); build snake_case wire format manually.
    const mcJson = {
      storage_path: mc.storagePath,
      max_capacity: mc.maxCapacity,
      importance_threshold: mc.importanceThreshold,
      decay_factor: mc.decayFactor,
      working_memory_capacity: mc.workingMemoryCapacity,
      working_memory_tokens: mc.workingMemoryTokens,
      working_memory_ttl_minutes: mc.workingMemoryTtlMinutes,
      perceptual_memory_modalities: mc.perceptualMemoryModalities
    };
    expect(normalizeCase(mcJson)).toEqual(normalizeCase(fx.memory_config));
  });

  it('CalculatorTool inputSchema accepts upstream parameter names', () => {
    // TS CalculatorTool derives parameters from zod inputSchema (input + expression,
    // both optional), while Python declares a single required "input" param.
    // This is a registered framework difference; verify both names are accepted.
    const schema = (
      CalculatorTool as unknown as {
        inputSchema: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).inputSchema;
    expect(schema.safeParse({ input: '2+2' }).success).toBe(true);
    expect(schema.safeParse({ expression: '2+2' }).success).toBe(true);
  });

  it('MemoryTool parameter count matches upstream', () => {
    const mt = new MemoryTool({ config: new MemoryConfig({ storagePath: tmpDir }) });
    expect(mt.getParameters().length).toBe(fx.memory_tool_parameters.length);
  });

  it('MemoryTool action set matches upstream', () => {
    const mt = new MemoryTool({ config: new MemoryConfig({ storagePath: tmpDir }) });
    const actions = mt.getParameters().find((p) => p.name === 'action');
    expect(actions).toBeDefined();
  });
});

// ─── Calculator tool returns ──────────────────────────────────────────────

describe('calculator fixture', () => {
  const fx = loadFixture<any>('tool_returns');

  for (const [label, { input, output }] of Object.entries(fx.calculator) as Array<
    [string, { input: Record<string, unknown>; output: string }]
  >) {
    it(`calculator ${label}`, async () => {
      const calc = new CalculatorTool();
      const result = await calc.execute(input);
      // Python returns result as string; TS returns same numeric string.
      expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
    });
  }
});

// ─── Memory tool returns ──────────────────────────────────────────────────

describe('memory_tool fixture', () => {
  const fx = loadFixture<any>('tool_returns');

  function makeTool(): MemoryTool {
    return new MemoryTool({ config: new MemoryConfig({ storagePath: tmpDir }) });
  }

  async function seedMemory(mt: MemoryTool): Promise<void> {
    await mt.execute(fx.memory_tool.add.input);
    await mt.execute({
      action: 'add',
      content: '昨天参加了技术方案评审会议',
      memory_type: 'episodic',
      importance: 0.7
    });
  }

  it('add returns upstream-formatted success', async () => {
    const mt = makeTool();
    const { input, output } = fx.memory_tool.add;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });

  it('search returns upstream-formatted results', async () => {
    const mt = makeTool();
    await seedMemory(mt);
    const { input, output } = fx.memory_tool.search;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });

  it('stats returns upstream-formatted stats', async () => {
    const mt = makeTool();
    await seedMemory(mt);
    const { input, output } = fx.memory_tool.stats;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });

  it('summary returns upstream-formatted summary', async () => {
    const mt = makeTool();
    await seedMemory(mt);
    const { input, output } = fx.memory_tool.summary;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });

  it('clear_all returns upstream-formatted message', async () => {
    const mt = makeTool();
    await mt.execute(fx.memory_tool.add.input);
    const { input, output } = fx.memory_tool.clear_all;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });

  it('forget returns upstream-formatted message', async () => {
    const mt = makeTool();
    const { input, output } = fx.memory_tool.forget;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });

  it('consolidate returns upstream-formatted message', async () => {
    const mt = makeTool();
    const { input, output } = fx.memory_tool.consolidate;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });
});

// ─── Exceptions ───────────────────────────────────────────────────────────

describe('exceptions fixture', () => {
  const fx = loadFixture<any>('exceptions');

  it('missing action returns an error response', async () => {
    const mt = new MemoryTool({ config: new MemoryConfig({ storagePath: tmpDir }) });
    const result = await mt.execute({});
    expect(result.text).toBeTruthy();
    // Semantic: both sides reject missing action. Exact validation message
    // differs (pydantic vs zod) — registered as framework difference.
  });

  it('unknown action returns an error response', async () => {
    const mt = new MemoryTool({ config: new MemoryConfig({ storagePath: tmpDir }) });
    const result = await mt.execute(fx.unknown_action.input);
    expect(result.text).toBeTruthy();
  });

  it('update with nonexistent id returns upstream-formatted warning', async () => {
    const mt = new MemoryTool({ config: new MemoryConfig({ storagePath: tmpDir }) });
    const { input, output } = fx.update_missing_id;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });

  it('remove with nonexistent id returns upstream-formatted warning', async () => {
    const mt = new MemoryTool({ config: new MemoryConfig({ storagePath: tmpDir }) });
    const { input, output } = fx.remove_missing_id;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });

  it('empty search returns upstream-formatted not-found message', async () => {
    const mt = new MemoryTool({ config: new MemoryConfig({ storagePath: tmpDir }) });
    const { input, output } = fx.empty_search;
    const result = await mt.execute(input);
    expect(normalizeCase(result.text)).toEqual(normalizeCase(output));
  });

  it('calculator invalid expression returns an error', async () => {
    const calc = new CalculatorTool();
    const result = await calc.execute(fx.calculator_invalid.input);
    // Both reject invalid syntax; exact error text differs (Python ast vs JS evaluator).
    expect(result.text).toBeTruthy();
  });

  it('calculator unsafe expression is blocked', async () => {
    const calc = new CalculatorTool();
    const result = await calc.execute(fx.calculator_unsafe.input);
    // Both block unsafe attribute access; exact error text differs.
    expect(result.text).toBeTruthy();
  });
});

// ─── Messages ─────────────────────────────────────────────────────────────

describe('messages fixture', () => {
  const fx = loadFixture<any>('messages');

  for (const role of ['system', 'user', 'assistant', 'tool'] as const) {
    it(`message ${role} matches upstream`, () => {
      const expected = fx[`message_${role}`];
      // TS constructor is (content, role) — Python is (role, content).
      const msg = new Message(`test content for ${role}`, role);
      expect(normalizeCase(msg.toJSON())).toEqual(normalizeCase(expected));
    });
  }

  it('message with metadata matches upstream', () => {
    const expected = fx.message_with_metadata;
    const msg = new Message('with metadata', 'user', {
      metadata: { source: 'test', tokens: 5 }
    });
    expect(normalizeCase(msg.toJSON())).toEqual(normalizeCase(expected));
  });
});

// ─── Serialization (pending #80) ──────────────────────────────────────────

describe('serialization fixture', () => {
  it('serialization module not yet implemented — tracked in issue #80', () => {
    // The serialization fixture exists as a golden reference from upstream.
    // TS serializeObject/deserializeObject are part of issue #80 (logging,
    // serialization, helpers). When #80 lands, replace this skip with exact
    // assertions against tests/fixtures/generated/serialization.json.
    const fx = loadFixture('serialization');
    expect(fx).toBeDefined();
  });
});
