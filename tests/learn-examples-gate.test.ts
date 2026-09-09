import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const UPSTREAM_EXAMPLES = resolve(ROOT, 'scripts/generate-fixtures/.upstream-ref/examples');

/** 上游教学示例 → TypeScript 可追踪对应文件（与 README 映射表一致）。 */
const MAPPINGS: ReadonlyArray<readonly [upstream: string, ts: readonly string[]]> = [
  ['agent/function_call_agent_demo.py', ['examples/function-call-agent-demo.ts']],
  ['chapter07_basic_setup.py', ['examples/chapter07-basic-setup.ts']],
  ['chapter08_memory_rag.py', ['examples/chapter08-memory.ts']],
  ['chapter09_context_engineering.py', ['examples/chapter09_context_engineering.ts']],
  [
    'chapter10_protocols.py',
    ['examples/chapter10-mcp.ts', 'examples/chapter10-a2a.ts', 'examples/chapter10-anp.ts']
  ],
  ['chapter11_RL.py', ['examples/chapter11-rl.ts']]
];

describe('learn examples traceability (#78)', () => {
  it('every upstream example has a tracked TypeScript counterpart', () => {
    for (const [upstream, tsFiles] of MAPPINGS) {
      const upstreamPath = resolve(UPSTREAM_EXAMPLES, upstream);
      expect(existsSync(upstreamPath), `上游示例缺失: ${upstream}`).toBe(true);
      for (const ts of tsFiles) {
        expect(existsSync(resolve(ROOT, ts)), `TS 对应缺失: ${ts} (← ${upstream})`).toBe(true);
      }
    }
  });

  it('mapping table is consistent with the README table', () => {
    for (const lang of ['README.md', 'README_CN.md']) {
      const readme = resolve(ROOT, lang);
      expect(existsSync(readme), `${lang} 缺失`).toBe(true);
      for (const [upstream, tsFiles] of MAPPINGS) {
        const upstreamBase = upstream.split('/').pop() as string;
        expect(
          readmeText(readme).includes(upstreamBase),
          `${lang} 未提及上游示例 ${upstreamBase}`
        ).toBe(true);
        for (const ts of tsFiles) {
          const tsBase = ts.split('/').pop() as string;
          expect(readmeText(readme).includes(tsBase), `${lang} 未提及 TS 对应 ${tsBase}`).toBe(
            true
          );
        }
      }
    }
  });
});

function readmeText(file: string): string {
  return readFileSync(file, 'utf8');
}
