import { TodoWriteTool } from '@junlang-7/helloagents';
import { heading } from './_shared.js';

heading('TodoWrite real-world workflow');
const todos = await TodoWriteTool.create({
  projectRoot: '/tmp',
  persistenceDir: 'helloagents-real-world'
});
await todos.execute({ action: 'clear' });
await todos.execute({
  action: 'create',
  summary: 'Ship a feature',
  todos: [
    { content: 'Implement', status: 'completed' },
    { content: 'Verify', status: 'in_progress' },
    { content: 'Release', status: 'pending' }
  ]
});
console.log(todos.summary, todos.todos.find((todo) => todo.status === 'in_progress')?.content);
