import { describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  Agent,
  HelloAgentsLLM,
  MockAdapter,
  SkillError,
  SkillLoader,
  SkillTool,
  ToolErrorCode,
  ToolRegistry
} from '../hello_agents/index.js';

async function writeSkill(
  root: string,
  directory: string,
  content: string,
  resources: readonly string[] = []
): Promise<void> {
  const folder = join(root, directory);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'SKILL.md'), content, 'utf8');
  for (const resource of resources) {
    const path = join(folder, resource);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, resource, 'utf8');
  }
}

describe('SkillLoader', () => {
  test('scans the synchronized repository skills when present', async () => {
    const skillsDir = join(dirname(import.meta.dir), 'skills');
    try {
      await access(join(skillsDir, 'web-search', 'SKILL.md'));
    } catch {
      return;
    }
    const loader = await SkillLoader.create({ skillsDir });
    expect(loader.listSkills()).toHaveLength(17);
    expect(loader.listSkills()).toContain('web-search');
    const skill = await loader.getSkill('web-search');
    expect(skill?.name).toBe('web-search');
    expect(skill?.body.length).toBeGreaterThan(0);
  });

  test('scans only frontmatter, then lazily loads content and resource metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-skills-'));
    try {
      await writeSkill(
        root,
        'writing',
        '---\nname: writer\ndescription: Help with writing\n---\nUse the supplied $ARGUMENTS style.',
        ['scripts/check.ts', 'references/guide.md', 'examples/demo.md']
      );
      const loader = await SkillLoader.create({ skillsDir: root });
      expect(loader.listSkills()).toEqual(['writer']);
      expect(loader.getDescriptions()).toBe('- writer: Help with writing');
      expect(loader.getCachedSkill('writer')).toBeUndefined();

      const skill = await loader.getSkill('writer');
      expect(skill).toMatchObject({ name: 'writer', description: 'Help with writing' });
      expect(skill?.body).toBe('Use the supplied $ARGUMENTS style.');
      expect(skill?.resources).toMatchObject({
        scripts: [join(root, 'writing/scripts/check.ts')],
        references: [join(root, 'writing/references/guide.md')],
        examples: [join(root, 'writing/examples/demo.md')]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reload reflects SKILL.md changes and rejects invalid or duplicate frontmatter as framework errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-skills-'));
    try {
      await writeSkill(root, 'one', '---\nname: first\ndescription: First\n---\nbody');
      const loader = await SkillLoader.create({ skillsDir: root });
      await writeSkill(root, 'one', '---\nname: second\ndescription: Second\n---\nupdated');
      await loader.reload();
      expect(loader.listSkills()).toEqual(['second']);
      expect((await loader.getSkill('second'))?.body).toBe('updated');

      await writeSkill(root, 'bad', '---\nname: 12\n---\nbody');
      await expect(loader.reload()).rejects.toBeInstanceOf(SkillError);
      expect(loader.listSkills()).toEqual(['second']);
      await rm(join(root, 'bad'), { recursive: true, force: true });
      await writeSkill(root, 'duplicate', '---\nname: second\ndescription: Duplicate\n---\nbody');
      await expect(loader.reload()).rejects.toThrow('Duplicate skill name');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('preserves empty quoted metadata and does not follow symlinked skill directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-skills-'));
    const outside = await mkdtemp(join(tmpdir(), 'helloagents-skill-outside-'));
    try {
      await writeSkill(root, 'empty', '---\nname: ""\ndescription: ""\n---\nbody');
      await writeSkill(outside, 'secret', '---\nname: secret\ndescription: secret\n---\nbody');
      await symlink(join(outside, 'secret'), join(root, 'linked'));
      const loader = await SkillLoader.create({ skillsDir: root });
      expect(loader.listSkills()).toEqual(['']);
      expect(await loader.getSkill('secret')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('SkillTool', () => {
  test('loads a skill through Function Calling schema, expands arguments, and normalizes missing errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-skills-'));
    try {
      await writeSkill(
        root,
        'writing',
        '---\nname: writer\ndescription: Help with writing\n---\nWrite for $ARGUMENTS.'
      );
      const loader = await SkillLoader.create({ skillsDir: root });
      const tool = new SkillTool(loader);
      const registry = new ToolRegistry().register(tool);
      expect(registry.toOpenAISchemas()[0]?.function.parameters).toMatchObject({
        required: ['skill']
      });
      expect(await registry.execute('Skill', { skill: 'writer', args: 'experts' })).toMatchObject({
        status: 'success',
        data: { name: 'writer', loaded: true },
        text: expect.stringContaining('Write for experts.')
      });
      expect((await tool.execute({ skill: 'unknown' })).errorInfo?.code).toBe(
        ToolErrorCode.NOT_FOUND
      );
      expect((await tool.execute({ skill: 'writer', args: 42 })).errorInfo?.code).toBe(
        ToolErrorCode.INVALID_PARAM
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Agent skill registration', () => {
  test('respects skillsEnabled and skillsAutoRegister configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-skills-'));
    try {
      await writeSkill(root, 'writing', '---\nname: writer\ndescription: Help\n---\nbody');
      const llm = new HelloAgentsLLM({
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: 'https://provider.test',
        adapter: new MockAdapter()
      });
      class TestAgent extends Agent {
        public async run(): Promise<string> {
          return '';
        }
      }
      const disabled = new TestAgent({
        name: 'disabled',
        llm,
        config: { skillsEnabled: false, skillsDir: root, skillsAutoRegister: true }
      });
      await expect(disabled.registerConfiguredSkills()).resolves.toBeUndefined();
      expect(disabled.toolRegistry.list()).toEqual([]);
      const enabled = new TestAgent({
        name: 'enabled',
        llm,
        config: { skillsEnabled: true, skillsDir: root, skillsAutoRegister: true }
      });
      await enabled.registerConfiguredSkills();
      expect(enabled.toolRegistry.list()).toEqual(['Skill']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
