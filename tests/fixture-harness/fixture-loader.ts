/**
 * Load generated fixtures from tests/fixtures/generated/.
 * Fixtures are committed JSON files — no network, no Python, no API keys.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'generated');

export interface FixtureManifest {
  upstream_sha: string;
  generated_at: string;
  python_version: string;
  normalization: Record<string, string | number>;
  cases: Record<string, { file: string; sources: string[] }>;
}

export function loadFixture<T = unknown>(name: string): T {
  const path = join(FIXTURE_DIR, `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

export function loadManifest(): FixtureManifest {
  return loadFixture<FixtureManifest>('manifest');
}

export function listFixtureNames(): string[] {
  const manifest = loadManifest();
  return Object.keys(manifest.cases).sort();
}
