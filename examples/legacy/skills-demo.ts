import { ToolRegistry } from '../../hello_agents/index.js';
import { SkillLoader } from '../../hello_agents/skills/loader.js';
import { SkillTool } from '../../hello_agents/tools/builtin/skill-tool.js';
import { heading } from '../_shared.js';

heading('skills');
const loader = await SkillLoader.create({ skillsDir: './skills' });
const tools = new ToolRegistry().register(new SkillTool(loader));
console.log(loader.listSkills());
console.log((await tools.execute('Skill', { skill: 'web-search', args: 'TypeScript' })).status);
