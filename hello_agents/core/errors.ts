import type { ZodType } from 'zod';

/** HelloAgents 所有标准化异常的基类。 */
export class HelloAgentsError extends Error {
  public constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 提供商或 LLM 客户端错误。 */
export class LLMError extends HelloAgentsError {}
/** 调用方取消 LLM 操作。 */
export class LLMAbortError extends LLMError {}
/** 因超时触发的 LLM 取消。 */
export class LLMTimeoutError extends LLMAbortError {}
/** Agent 执行或生命周期错误。 */
export class AgentError extends HelloAgentsError {}
/** 配置或配置来源无效。 */
export class ConfigError extends HelloAgentsError {}
/** 工具校验、执行或协议错误。 */
export class ToolError extends HelloAgentsError {}
/** 技能发现、解析或加载错误。 */
export class SkillError extends HelloAgentsError {}

type ErrorConstructor = new (message: string, cause?: unknown) => HelloAgentsError;

/** 校验未知输入，失败时抛出指定的标准化异常。 */
export function parseOrThrow<T>(
  schema: ZodType<T>,
  input: unknown,
  label: string,
  ErrorType: ErrorConstructor = ConfigError
): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const fields = parsed.error.issues
    .map((issue) => (issue.path.length === 0 ? '<root>' : issue.path.join('.')))
    .join(', ');
  throw new ErrorType(`Invalid ${label}${fields ? `: ${fields}` : ''}`);
}
