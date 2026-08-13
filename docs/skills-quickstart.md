# Skills quickstart

Skills are directories containing a `SKILL.md` document. `SkillLoader` scans
frontmatter first and loads the body only when requested:

```ts
import { SkillLoader, SkillTool, ToolRegistry } from '@junlang-7/helloagents';

const loader = await SkillLoader.create({ skillsDir: './skills' });
console.log(loader.listSkills());
const tools = new ToolRegistry().register(new SkillTool(loader));
await tools.execute('Skill', { skill: 'web-search', args: 'latest TypeScript release' });
```

Frontmatter requires `name` and `description`; optional `license` and `version`
are accepted. Keep provider credentials in the skill runtime, never in a
checked-in skill file.
