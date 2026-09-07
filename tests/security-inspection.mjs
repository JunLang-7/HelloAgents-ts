import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workflow = readFileSync(join(repositoryRoot, '.github/workflows/integration.yml'), 'utf8');
const integrationScriptPath = join(repositoryRoot, 'tests/real-api-opt-in.mjs');
const integrationScript = readFileSync(integrationScriptPath, 'utf8');

assert.match(workflow, /refs\/heads\/learn-version/);
assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
assert.doesNotMatch(workflow, /ref:\s*learn-version/);
assert.match(workflow, /needs: dispatch-ref/);

const actionReferences = [...workflow.matchAll(/^\s*- uses:\s*(\S+)/gm)].map((match) => match[1]);
assert.deepEqual(actionReferences.length, 2);
for (const actionReference of actionReferences) {
  assert.match(actionReference, /@[0-9a-f]{40}$/);
}

assert.doesNotMatch(integrationScript, /response\.model/);
assert.doesNotMatch(integrationScript, /console\.(log|error)/);
assert.doesNotMatch(integrationScript, /catch\s*\(error\)/);
assert.match(integrationScript, /Real API integration failed \(details redacted\)/);
assert.doesNotMatch(integrationScript, /String\(error\)/);

const modelSecret = 'inspection-model-secret';
const apiSecret = 'inspection-api-secret';
const baseUrlSecret = 'https://inspection.invalid/secret';
const skipped = spawnSync(process.execPath, [integrationScriptPath], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    HELLOAGENTS_INTEGRATION: '0',
    LLM_MODEL_ID: modelSecret,
    LLM_API_KEY: apiSecret,
    LLM_BASE_URL: baseUrlSecret
  }
});
assert.equal(skipped.status, 0);
const skippedOutput = `${skipped.stdout}${skipped.stderr}`;
assert.match(skippedOutput, /Skipping real API integration test/);
for (const secret of [
  modelSecret,
  apiSecret,
  baseUrlSecret,
  'LLM_MODEL_ID',
  'LLM_API_KEY',
  'LLM_BASE_URL'
]) {
  assert.doesNotMatch(skippedOutput, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

const providerErrorBody = `provider response ${modelSecret} ${apiSecret}`;
const server = createServer((_request, response) => {
  response.writeHead(500, { 'content-type': 'text/plain' });
  response.end(providerErrorBody);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.equal(typeof address, 'object');
try {
  let failed;
  try {
    await execFileAsync(process.execPath, [integrationScriptPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HELLOAGENTS_INTEGRATION: '1',
        LLM_MODEL_ID: modelSecret,
        LLM_API_KEY: apiSecret,
        LLM_BASE_URL: `http://127.0.0.1:${address.port}`
      }
    });
    assert.fail('the integration script must fail for a provider error');
  } catch (error) {
    failed = error;
  }
  assert.equal(failed.code, 1);
  const failureOutput = `${failed.stdout}${failed.stderr}`;
  assert.match(failureOutput, /Real API integration failed \(details redacted\)/);
  assert.doesNotMatch(failureOutput, /provider response/);
  assert.doesNotMatch(failureOutput, new RegExp(modelSecret));
  assert.doesNotMatch(failureOutput, new RegExp(apiSecret));
} finally {
  server.close();
}
