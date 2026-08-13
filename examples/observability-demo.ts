import { SimpleAgent, TraceLogger } from '@junlang-7/helloagents';
import { heading, mockLlm } from './_shared.js';

heading('observability');
const trace = await TraceLogger.create({ outputDir: '/tmp/helloagents-traces' });
try {
  const agent = new SimpleAgent({
    name: 'observed-demo',
    llm: mockLlm(['Observed answer']),
    traceLogger: trace
  });
  await agent.run('Record this run.');
  console.log(trace.computeStats());
} finally {
  await trace.finalize();
}
