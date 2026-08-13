import { TodoWriteTool } from '@junlang-7/helloagents';
import { heading } from './_shared.js';

heading('TodoWrite');
const todos = await TodoWriteTool.create({
  projectRoot: '/tmp',
  persistenceDir: 'helloagents-example'
});
await todos.execute({
  action: 'create',
  summary: 'Demo checklist',
  todos: [
    { content: 'Run example', status: 'in_progress' },
    { content: 'Review output', status: 'pending' }
  ]
});
console.log(todos.todos);
