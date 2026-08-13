import { CalculatorTool, ToolRegistry } from '@junlang-7/helloagents';
import { heading } from './_shared.js';

heading('ToolResponse');
const tools = new ToolRegistry().register(new CalculatorTool());
console.log((await tools.execute('Calculator', { expression: 'sqrt(81)' })).toJSON());
console.log((await tools.execute('Calculator', { expression: 'not allowed' })).toJSON());
