# Workspace file tools

File tools require an explicit workspace root. They reject paths outside that
root and refuse symlink traversal:

```ts
import { ReadTool, WriteTool, ToolRegistry } from '@junlang-7/helloagents';

const tools = new ToolRegistry();
tools.register(new ReadTool({ workspaceRoot: './workspace', registry: tools }));
tools.register(new WriteTool({ workspaceRoot: './workspace', registry: tools }));
console.log(await tools.execute('Read', { path: 'README.md' }));
```

Read metadata is cached in the registry. A later edit compares the cached
mtime/hash and returns `CONFLICT` instead of overwriting external changes.
Large reads return a partial response; use `maxReadBytes` to tune the limit.
