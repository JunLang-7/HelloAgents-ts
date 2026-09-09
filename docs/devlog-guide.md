# Development log guide

`DevLogTool` is a durable journal for decisions and handoffs. Create it with a
stable session and agent identity:

```ts
// 1.x-only capability — not exported from the teaching entrypoint (#81);
// reference the source file directly inside the repository.
import { DevLogTool } from '../hello_agents/tools/builtin/dev-log-tool.js';

const log = await DevLogTool.create({
  sessionId: 'release-1',
  agentName: 'maintainer',
  projectRoot: process.cwd()
});
await log.execute({
  action: 'append',
  category: 'decision',
  content: 'Keep hello_agents/ as the source root.'
});
```

Entries are written atomically under the configured persistence directory.
Use the tool's `list`, `filter`, and `summary` actions to inspect the journal;
the JSON schema rejects unknown categories and malformed persisted data.
