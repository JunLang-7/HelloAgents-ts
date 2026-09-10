import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const UPSTREAM_EXAMPLES = resolve(ROOT, 'scripts/generate-fixtures/.upstream-ref');
const MANIFEST = resolve(ROOT, 'examples/upstream-example-manifest.json');

interface ManifestExample {
  readonly upstream: string;
  readonly ts: readonly string[];
}

/** 权威清单来自受版本控制的 examples/upstream-example-manifest.json（#78）。 */
function loadManifest(): ManifestExample[] {
  const raw = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    baseline: string;
    examples: ManifestExample[];
  };
  expect(raw.baseline).toBe('3927c6d1decb37737c4c1344fde00ccef55ab1f3');
  expect(raw.examples.length).toBeGreaterThan(0);
  return raw.examples;
}

describe('learn examples traceability (#78)', () => {
  it('manifest declares every upstream example and each TS counterpart exists', () => {
    for (const entry of loadManifest()) {
      // .upstream-ref 是本地浅克隆（gitignored），CI 上不存在；存在时才校验上游文件。
      if (existsSync(UPSTREAM_EXAMPLES)) {
        expect(
          existsSync(resolve(UPSTREAM_EXAMPLES, entry.upstream)),
          `上游示例缺失: ${entry.upstream}`
        ).toBe(true);
      }
      expect(entry.ts.length, `映射缺少 TS 对应: ${entry.upstream}`).toBeGreaterThan(0);
      for (const ts of entry.ts) {
        expect(existsSync(resolve(ROOT, ts)), `TS 对应缺失: ${ts} (← ${entry.upstream})`).toBe(
          true
        );
      }
    }
  });

  it('manifest mapping is consistent with the README table', () => {
    for (const lang of ['README.md', 'README_CN.md']) {
      const readme = resolve(ROOT, lang);
      expect(existsSync(readme), `${lang} 缺失`).toBe(true);
      for (const entry of loadManifest()) {
        const upstreamBase = entry.upstream.split('/').pop() as string;
        expect(
          readmeText(readme).includes(upstreamBase),
          `${lang} 未提及上游示例 ${upstreamBase}`
        ).toBe(true);
        for (const ts of entry.ts) {
          const tsBase = ts.split('/').pop() as string;
          expect(readmeText(readme).includes(tsBase), `${lang} 未提及 TS 对应 ${tsBase}`).toBe(
            true
          );
        }
      }
    }
  });

  it('function-call dry-run actually executes the registered tool', async () => {
    // 通过子进程跑示例：mock 首轮必须是结构化 tool_call，工具执行次数必须为 1。
    const proc = Bun.spawn(['bun', 'run', 'examples/function-call-agent-demo.ts'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, OPENAI_API_KEY: '', HELLOAGENTS_REAL_API: '' }
    });
    const [stdout, stderr] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr)
    ]);
    const exitCode = await proc.exited;
    expect(exitCode, stderr || '示例应以 0 退出').toBe(0);
    expect(stdout, 'dry-run 应真实执行 get_horoscope').toContain('get_horoscope 实际执行次数: 1');
  });
});

function readmeText(file: string): string {
  return readFileSync(file, 'utf8');
}
