import { Message, SessionStore } from '@junlang-7/helloagents';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { heading } from './_shared.js';

heading('session persistence');
const directory = join('/tmp', 'helloagents-session-example');
await mkdir(directory, { recursive: true });
try {
  const store = new SessionStore({ sessionDir: directory });
  const path = await store.save({
    sessionName: 'demo',
    agentConfig: { name: 'demo', llm_model: 'example-model' },
    history: [new Message('Persist me.', 'user')],
    toolSchemaHash: 'ts-demo',
    readCache: {},
    metadata: {}
  });
  console.log((await store.load(path)).history[0]?.toText());
} finally {
  await rm(directory, { recursive: true, force: true });
}
