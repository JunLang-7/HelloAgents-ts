# Context engineering guide

Use the context modules independently when building a bounded prompt:

```ts
import { ContextBuilder, HistoryManager, Message } from '@junlang-7/helloagents';

const history = new HistoryManager({ maxTokens: 4096, retainRecentTurns: 2 });
history.add(new Message('Earlier answer', 'assistant'));
history.add(new Message('New question', 'user'));
const context = new ContextBuilder({ maxTokens: 4096 }).build({
  systemInstructions: 'Answer concisely.',
  conversationHistory: history.getAll(),
  userQuery: 'Continue the discussion.'
});
```

`HistoryManager.compact()` removes complete older turns. `TokenCounter` provides
deterministic estimates, `ObservationTruncator` preserves oversized tool output,
and `WorkingMemory` stores bounded priority/expiry-aware notes.
