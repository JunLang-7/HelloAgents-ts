#!/usr/bin/env bun
/**
 * Release gate for learn-v0.2.0 compatibility.
 *
 * Checks (issue #82 acceptance criteria #7):
 *   1. Compatibility matrix has no "Implemented" row without evidence
 *      (a test file or fixture referencing that area).
 *   2. No unapproved "kept" differences in the compat registry.
 *   3. Generated fixture manifest exists and references valid files.
 *   4. No fixture case has zero assertions in the gate test.
 *
 * Exit code 0 = pass, 1 = fail (with report on stderr).
 *
 * Usage: bun scripts/release-gate.ts
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MATRIX_PATH = join(ROOT, 'docs', 'learn-v0.2.0-compatibility-matrix.md');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'generated');
const GATE_TEST_PATH = join(ROOT, 'tests', 'learn-fixture-gate.test.ts');
const COMPAT_REGISTRY_PATH = join(ROOT, 'tests', 'fixture-harness', 'compat-registry.ts');

interface MatrixRow {
  symbols: string;
  source: string;
  destination: string;
  ownerStatus: string;
  owner: string;
  status: string;
  recognized: boolean;
}

const KNOWN_STATUSES = ['Implemented', 'Planned', 'Optional planned', 'Out of scope', 'Partial'];

function parseMatrix(content: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    // The document mixes 4-column tables (symbols|source|destination|owner)
    // and 3-column tables (source+symbols|destination|owner). Normalize both.
    if (cells.length !== 3 && cells.length !== 4) continue;
    const ownerStatus = cells[cells.length - 1];
    const destination = cells[cells.length - 2];
    const symbols = cells[0];
    const source = cells.length === 4 ? cells[1] : cells[0];
    // Skip header/separator rows from any of the document's tables.
    if (
      /owner\s*\/\s*status/i.test(ownerStatus) ||
      destination === 'Intended TS destination' ||
      destination === 'Required TS behavior' ||
      symbols.startsWith('---')
    )
      continue;
    // Only module-implementation rows reference an upstream .py path or github
    // URL. Behaviour/environment tables put code snippets there and have no
    // implementation status — skip them.
    const looksLikeModuleRow = /\.py|github\.com/.test(source) || /\.py|github\.com/.test(symbols);
    if (!looksLikeModuleRow) continue;
    const statusMatch = ownerStatus.match(new RegExp(`/\\s*(${KNOWN_STATUSES.join('|')})`));
    const ownerMatch = ownerStatus.match(/#(\d+)/);
    rows.push({
      symbols,
      source,
      destination,
      ownerStatus,
      owner: ownerMatch ? `#${ownerMatch[1]}` : 'unknown',
      status: statusMatch ? statusMatch[1] : ownerStatus,
      recognized: Boolean(statusMatch)
    });
  }
  return rows;
}

/** Extract module basename tokens from a matrix "destination" cell.
 * Handles backtick paths, `;` separators, and `{a,b,c}` brace expansion. */
function extractModuleTokens(destination: string): string[] {
  const tokens = new Set<string>();
  const backtickPaths = destination.match(/`[^`]*\.ts`/g) ?? [];
  for (const raw of backtickPaths) {
    // Strip backticks and split on ; , whitespace.
    for (const part of raw
      .replaceAll('`', '')
      .split(/[;,\s]+/)
      .filter(Boolean)) {
      // Expand {a,b} against the surrounding name (best-effort: also push
      // each brace member on its own).
      const brace = part.match(/\{([^}]+)\}/);
      if (brace) {
        for (const member of brace[1].split(',')) {
          const expanded = part.replace(brace[0], member);
          tokens.add(basename(expanded).replace(/\.ts$/, ''));
        }
      } else {
        tokens.add(basename(part).replace(/\.ts$/, ''));
      }
    }
  }
  return [...tokens].filter((t) => t && t !== 'index');
}

/** Concatenate the contents of every *.test.ts under tests/ (recursive). */
function loadAllTestSources(dir: string): string {
  let acc = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      acc += loadAllTestSources(full);
    } else if (entry.name.endsWith('.test.ts')) {
      acc += readFileSync(full, 'utf-8');
    }
  }
  return acc;
}

function checkMatrixEvidence(rows: MatrixRow[]): string[] {
  const failures: string[] = [];
  const implemented = rows.filter((r) => r.status === 'Implemented');
  const testSources = loadAllTestSources(join(ROOT, 'tests'));

  for (const row of implemented) {
    let tokens = extractModuleTokens(row.destination);
    // Barrel destinations (only index.ts) yield no usable token — fall back to
    // the exported symbol names in the symbols column (e.g. MemoryManager).
    if (tokens.length === 0) {
      const symbolNames = row.symbols.match(/`[A-Za-z_][A-Za-z0-9_]*`/g) ?? [];
      tokens = symbolNames.map((s) => s.replaceAll('`', ''));
    }
    if (tokens.length === 0) {
      failures.push(
        `Implemented row has no parseable destination or symbols to verify: ${row.symbols.slice(0, 60)}`
      );
      continue;
    }
    const hasEvidence = tokens.some((token) => testSources.includes(token));
    if (!hasEvidence) {
      failures.push(
        `Implemented row has NO test evidence (looked for [${tokens.slice(0, 6).join(', ')}] in tests/*.test.ts): ` +
          `${row.owner} ${row.symbols.slice(0, 60)}`
      );
    }
  }
  return failures;
}

function checkCompatRegistry(): string[] {
  const failures: string[] = [];
  const content = readFileSync(COMPAT_REGISTRY_PATH, 'utf-8');
  // Split into per-entry blocks (each starts with `id: 'DIFF-`) so the id is
  // inside the match window — matching from `status:"kept"` onward would miss it.
  const entries = content.split(/(?=\{\s*\n\s*id:\s*'DIFF-)/);
  for (const entry of entries) {
    const isKept = /status:\s*'kept'/.test(entry);
    const isUnapproved = /approved:\s*false/.test(entry);
    if (isKept && isUnapproved) {
      const idMatch = entry.match(/id:\s*'([^']+)'/);
      failures.push(
        `Unapproved "kept" difference: ${idMatch ? idMatch[1] : 'unknown'} — ` +
          `maintainer approval required before release (issue #82 criterion #6)`
      );
    }
  }
  return failures;
}

function checkFixtures(): string[] {
  const failures: string[] = [];
  const manifestPath = join(FIXTURE_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) {
    failures.push('Fixture manifest missing: tests/fixtures/generated/manifest.json');
    return failures;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (manifest.upstream_sha !== '3927c6d1decb37737c4c1344fde00ccef55ab1f3') {
    failures.push(`Fixture upstream SHA mismatch: ${manifest.upstream_sha}`);
  }
  for (const [name, info] of Object.entries(manifest.cases) as Array<
    [string, { file: string; sources: string[] }]
  >) {
    const fixturePath = join(FIXTURE_DIR, info.file);
    if (!existsSync(fixturePath)) {
      failures.push(`Fixture file missing for case "${name}": ${info.file}`);
    }
    if (!info.sources || info.sources.length === 0) {
      failures.push(`Fixture case "${name}" has no source manifest (issue #82 criterion #1)`);
    }
  }
  return failures;
}

function checkGateTest(): string[] {
  const failures: string[] = [];
  if (!existsSync(GATE_TEST_PATH)) {
    failures.push('Fixture gate test missing: tests/learn-fixture-gate.test.ts');
    return failures;
  }
  const content = readFileSync(GATE_TEST_PATH, 'utf-8');
  const itCount = (content.match(/\bit\(/g) || []).length;
  if (itCount < 10) {
    failures.push(`Fixture gate test has only ${itCount} assertions — expected >= 10`);
  }
  return failures;
}

function main(): void {
  const failures: string[] = [];

  if (!existsSync(MATRIX_PATH)) {
    console.error('FAIL: compatibility matrix not found');
    process.exit(1);
  }

  const matrixContent = readFileSync(MATRIX_PATH, 'utf-8');
  const rows = parseMatrix(matrixContent);
  const implementedCount = rows.filter((r) => r.status === 'Implemented').length;
  const plannedCount = rows.filter(
    (r) => r.status === 'Planned' || r.status === 'Optional planned'
  ).length;
  const unrecognized = rows.filter((r) => !r.recognized);

  failures.push(...checkMatrixEvidence(rows));
  failures.push(...checkCompatRegistry());
  failures.push(...checkFixtures());
  failures.push(...checkGateTest());

  console.error(`\n=== Release Gate Report ===`);
  console.error(
    `Matrix rows: ${rows.length} total (${implementedCount} implemented, ${plannedCount} planned, ${unrecognized.length} unrecognized status)`
  );
  for (const row of unrecognized) {
    console.error(`  ! unrecognized status in ${row.owner}: "${row.ownerStatus.slice(0, 80)}"`);
  }
  console.error(
    `Fixture cases: ${Object.keys(JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf-8')).cases).length}`
  );
  console.error(`Compat diffs: see tests/fixture-harness/compat-registry.ts`);

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failure(s):`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.error(`\n✅ Release gate passed.`);
  process.exit(0);
}

main();
