import { ContextBuilder, ContextConfig, HistoryManager, Message } from '@junlang-7/helloagents';
import { heading } from './_shared.js';

async function main(): Promise<void> {
  heading('context engineering');
  const history = new HistoryManager({ maxTokens: 80, retainRecentTurns: 1 });
  history.add(new Message('The first answer.', 'assistant'));
  history.add(new Message('The current question.', 'user'));
  const context = await new ContextBuilder(
    undefined,
    undefined,
    new ContextConfig({ max_tokens: 200 })
  ).build('What should happen next?', history.getAll(), 'Be concise.');
  console.log(context);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
