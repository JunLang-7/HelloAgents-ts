import { streamToSse, AgentEvent } from '@junlang-7/helloagents';
import { heading } from './_shared.js';

heading('SSE client');
async function* events(): AsyncIterable<AgentEvent> {
  yield AgentEvent.create('agent_start', 'sse-demo', { input_text: 'hello' });
  yield AgentEvent.create('agent_finish', 'sse-demo', { result: 'done' });
}
for await (const chunk of streamToSse(events())) process.stdout.write(chunk);
