import assert from 'node:assert/strict';

const packageEntry = await import('../dist/index.js');

assert.equal(packageEntry.version, '0.0.0-development');
assert.equal(packageEntry.metadata.name, '@junlang-7/helloagents');
