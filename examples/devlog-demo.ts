import { DevLogTool } from '@junlang-7/helloagents';
import { heading } from './_shared.js';

heading('development log');
const log = await DevLogTool.create({
  sessionId: 'example-devlog',
  agentName: 'demo',
  projectRoot: '/tmp'
});
await log.execute({ action: 'append', category: 'decision', content: 'Use a mock provider.' });
console.log((await log.execute({ action: 'summary' })).text);
