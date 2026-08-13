import { ContextBuilder, HistoryManager, Message } from '@junlang-7/helloagents';
import { heading } from './_shared.js';

heading('context engineering');
const history = new HistoryManager({ maxTokens: 80, retainRecentTurns: 1 });
history.add(new Message('The first answer.', 'assistant'));
history.add(new Message('The current question.', 'user'));
console.log(
  new ContextBuilder({ maxTokens: 200 }).build({
    systemInstructions: 'Be concise.',
    conversationHistory: history.getAll(),
    userQuery: 'What should happen next?'
  })
);
