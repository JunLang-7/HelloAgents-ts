import assert from 'node:assert/strict';

const packageEntry = await import('../dist/index.js');

assert.equal(packageEntry.version, '0.0.0-development');
assert.equal(packageEntry.metadata.name, '@junlang-7/helloagents');
assert.equal(packageEntry.createConfig().contextWindow, 128_000);
assert.equal(
  packageEntry.Message.fromJSON({
    role: 'user',
    content: 'Node-compatible',
    timestamp: '2026-08-12T12:34:56.123456',
    metadata: {}
  }).toText(),
  '[user] Node-compatible'
);
assert.equal(
  packageEntry.Message.fromJSON({
    role: 'user',
    content: 'x',
    timestamp: '2026-08-12T12:34:56.123456',
    metadata: {}
  }).toJSON().timestamp,
  '2026-08-12T12:34:56.123456'
);
