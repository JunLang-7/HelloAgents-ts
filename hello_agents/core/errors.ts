import type { ZodType } from 'zod';

/** Base error for all normalized HelloAgents failures. */
export class HelloAgentsError extends Error {
  public constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Provider or LLM client failure. */
export class LLMError extends HelloAgentsError {}
/** Caller cancellation of an LLM operation. */
export class LLMAbortError extends LLMError {}
/** Timeout-triggered LLM cancellation. */
export class LLMTimeoutError extends LLMAbortError {}
/** Agent execution or lifecycle failure. */
export class AgentError extends HelloAgentsError {}
/** Invalid configuration or configuration source. */
export class ConfigError extends HelloAgentsError {}
/** Tool validation, execution, or protocol failure. */
export class ToolError extends HelloAgentsError {}
/** Skill discovery, parsing, or loading failure. */
export class SkillError extends HelloAgentsError {}

type ErrorConstructor = new (message: string, cause?: unknown) => HelloAgentsError;

/** Validates unknown input and raises the selected normalized error on failure. */
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
