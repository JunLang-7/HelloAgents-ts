import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DevLogTool, TodoWriteTool } from '../dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'helloagents-node-todo-devlog-'));
try {
  const todo = await TodoWriteTool.create({ projectRoot: root });
  assert.equal(
    (await todo.execute({ todos: [{ content: 'ship', status: 'in_progress' }] })).status,
    'success'
  );
  assert.equal((await TodoWriteTool.create({ projectRoot: root })).todos.length, 1);

  const log = await DevLogTool.create({
    sessionId: 'node-smoke',
    agentName: 'node',
    projectRoot: root
  });
  assert.equal(
    (
      await log.execute({
        action: 'append',
        category: 'test',
        content: 'Node persistence round trip'
      })
    ).status,
    'success'
  );
  assert.equal(JSON.parse(await readFile(log.persistencePath, 'utf8')).entries.length, 1);
  assert.equal(
    (await DevLogTool.create({ sessionId: 'node-smoke', agentName: 'node', projectRoot: root }))
      .logEntries.length,
    1
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
