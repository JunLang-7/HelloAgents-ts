import { z } from 'zod';

import type { SkillLoader, SkillResources } from '../../skills/loader.js';
import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';

/** 渐进式技能加载的 Function Calling 入口。 */
export class SkillTool extends Tool<typeof SkillTool.inputSchema> {
  static readonly inputSchema = z
    .object({ skill: z.string().min(1), args: z.string().optional() })
    .strict();

  public constructor(private readonly loader: SkillLoader) {
    super({
      name: 'Skill',
      description: `加载技能获取专业知识。\n\n可用技能：\n${loader.getDescriptions()}`,
      inputSchema: SkillTool.inputSchema
    });
  }

  protected override async run(
    input: z.output<typeof SkillTool.inputSchema>
  ): Promise<ToolResponse> {
    try {
      const skill = await this.loader.getSkill(input.skill);
      if (!skill) {
        const available = this.loader.listSkills();
        return ToolResponse.error(
          ToolErrorCode.NOT_FOUND,
          `技能 '${input.skill}' 不存在。可用技能：${available.join(', ')}`,
          undefined,
          { available_skills: available }
        );
      }
      const content = skill.body.replaceAll('$ARGUMENTS', input.args ?? '');
      const resourceEntries = (
        Object.entries(skill.resources) as [keyof SkillResources, readonly string[]][]
      ).filter(([, entries]) => entries.length > 0);
      const resourcesHint =
        resourceEntries.length === 0
          ? ''
          : `\n\n**可用资源**：\n${resourceEntries
              .map(
                ([name, entries]) =>
                  `  - ${name}：${entries
                    .slice(0, 5)
                    .map((entry) => entry.split('/').at(-1))
                    .join(', ')}`
              )
              .join('\n')}`;
      const text = `<skill-loaded name="${skill.name}">\n${content}${resourcesHint}\n</skill-loaded>\n\n✅ 技能已加载：${skill.name}\n📝 描述：${skill.description}\n\n请严格遵循上述技能说明来完成用户任务。`;
      return ToolResponse.success(text, {
        name: skill.name,
        description: skill.description,
        loaded: true,
        token_estimate: text.length,
        has_resources: resourceEntries.length > 0
      });
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.INTERNAL_ERROR,
        `加载技能失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
