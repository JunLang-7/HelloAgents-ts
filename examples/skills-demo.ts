import { SkillLoader, SkillTool, ToolRegistry } from '@junlang-7/helloagents';
import { heading } from './_shared.js';

heading('skills');
const loader = await SkillLoader.create({ skillsDir: './skills' });
const tools = new ToolRegistry().register(new SkillTool(loader));
console.log(loader.listSkills());
console.log((await tools.execute('Skill', { skill: 'web-search', args: 'TypeScript' })).status);
