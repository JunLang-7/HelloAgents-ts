import type { ZodType } from 'zod';

/** HelloAgents 所有标准化异常的基类。 */
export class HelloAgentsException extends Error {
  public constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** LLM 相关异常。 */
export class LLMException extends HelloAgentsException {}
/** Agent 执行相关异常。 */
export class AgentException extends HelloAgentsException {}
/** 配置或配置来源无效。 */
export class ConfigException extends HelloAgentsException {}
/** 工具校验、执行或协议错误。 */
export class ToolException extends HelloAgentsException {}

/** TypeScript API 中更具体的 LLM 错误别名。 */
export class LLMError extends LLMException {}
/** 调用方取消 LLM 操作。 */
export class LLMAbortError extends LLMError {}
/** 因超时触发的 LLM 取消。 */
export class LLMTimeoutError extends LLMAbortError {}
/** TypeScript API 中更具体的 Agent 错误别名。 */
export class AgentError extends AgentException {}
/** TypeScript API 中更具体的配置错误别名。 */
export class ConfigError extends ConfigException {}
/** TypeScript API 中更具体的工具错误别名。 */
export class ToolError extends ToolException {}
/** 技能发现、解析或加载错误。 */
export class SkillError extends ToolException {}

type ErrorConstructor = new (message: string, cause?: unknown) => HelloAgentsException;

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

/** Historical TypeScript name retained for consumers of the pre-learn API. */
export { HelloAgentsException as HelloAgentsError };
