import { AgentEvent, streamToJsonLines } from '@junlang-7/helloagents';
import { heading } from './_shared.js';

heading('SSE server payload');
async function* events(): AsyncIterable<AgentEvent> {
  yield AgentEvent.create('llm_chunk', 'server-demo', { chunk: 'hello' });
  yield AgentEvent.create('agent_finish', 'server-demo', { result: 'hello' });
}
for await (const line of streamToJsonLines(events())) process.stdout.write(line);
