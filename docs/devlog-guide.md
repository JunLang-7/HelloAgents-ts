# Development log guide

`DevLogTool` is a durable journal for decisions and handoffs. Create it with a
stable session and agent identity:

```ts
import { DevLogTool } from '@junlang-7/helloagents';

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
