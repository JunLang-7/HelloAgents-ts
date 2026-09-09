import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../../hello_agents/index.js';
import { GlobTool, ReadTool, WriteTool } from '../../hello_agents/tools/builtin/file-tools.js';
import { heading } from '../_shared.js';

heading('workspace file tools');
const root = await mkdtemp(join(tmpdir(), 'helloagents-example-'));
try {
  await mkdir(join(root, 'notes'));
  await writeFile(join(root, 'notes', 'readme.txt'), 'hello workspace\n', 'utf8');
  const tools = new ToolRegistry();
  tools.register(new ReadTool({ workspaceRoot: root }));
  tools.register(new WriteTool({ workspaceRoot: root }));
  tools.register(new GlobTool({ workspaceRoot: root }));
  console.log((await tools.execute('Read', { path: 'notes/readme.txt' })).text);
  console.log((await tools.execute('Glob', { pattern: '**/*.txt' })).text);
} finally {
  await rm(root, { recursive: true, force: true });
}
