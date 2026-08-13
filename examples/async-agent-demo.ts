import { SimpleAgent } from '@junlang-7/helloagents';
import { heading, mockLlm } from './_shared.js';

heading('async agent');
const agent = new SimpleAgent({ name: 'async-demo', llm: mockLlm(['Async answer']) });
console.log(await agent.run('Answer asynchronously.'));
