# TodoWrite usage guide

Create a durable todo tool and update the list through its structured actions:

```ts
import { TodoWriteTool } from '@junlang-7/helloagents';

const todos = await TodoWriteTool.create({ projectRoot: process.cwd() });
await todos.execute({
  action: 'create',
  summary: 'Release checklist',
  todos: [{ content: 'Run tests', status: 'in_progress' }]
});
console.log(todos.todos, todos.summary);
```

At most one item can be `in_progress`. Updates are serialized and written
atomically to `todo-list.json`; `clear` removes all items while preserving the
validated persistence format.
