import { TodoWriteTool } from '../../hello_agents/tools/builtin/todo-write-tool.js';
import { DevLogTool } from '../../hello_agents/tools/builtin/dev-log-tool.js';

const todos = await TodoWriteTool.create({ projectRoot: process.cwd() });
await todos.execute({
  summary: 'Release checklist',
  todos: [
    { content: 'Run verification', status: 'in_progress' },
    { content: 'Publish package', status: 'pending' }
  ]
});

const log = await DevLogTool.create({
  sessionId: 'release-example',
  agentName: 'release-bot',
  projectRoot: process.cwd()
});
await log.execute({
  action: 'append',
  category: 'decision',
  content: 'Use Bun-first release checks.'
});

console.log(
  (
    await todos.execute({
      action: 'update',
      todos: todos.todos.map(({ content, status, created_at }) => ({ content, status, created_at }))
    })
  ).text
);
console.log((await log.execute({ action: 'summary' })).text);
