import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'helloagents-package-'));
const packageName = '@junlang-7/helloagents';
const expectedVersion = '0.0.0-development';
const importCheck = `import { metadata, version } from '${packageName}';
if (version !== '${expectedVersion}' || metadata.name !== '${packageName}') process.exit(1);`;

function run(command, arguments_, cwd) {
  return execFileSync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

try {
  const packResult = run(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    repositoryRoot
  );
  const packedFile = JSON.parse(packResult)[0]?.filename;
  assert.equal(typeof packedFile, 'string', 'npm pack must produce one archive');

  const archivePath = join(temporaryDirectory, basename(packedFile));
  const bunConsumer = join(temporaryDirectory, 'bun-consumer');
  const npmConsumer = join(temporaryDirectory, 'npm-consumer');

  mkdirSync(bunConsumer, { recursive: true });
  mkdirSync(npmConsumer, { recursive: true });
  writeFileSync(join(bunConsumer, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(npmConsumer, 'package.json'), JSON.stringify({ type: 'module' }));

  run('bun', ['add', '--no-save', archivePath], bunConsumer);
  run('bun', ['-e', importCheck], bunConsumer);

  run('npm', ['install', '--ignore-scripts', archivePath], npmConsumer);
  run(process.execPath, ['--input-type=module', '--eval', importCheck], npmConsumer);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
