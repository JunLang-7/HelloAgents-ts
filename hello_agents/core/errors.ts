import type { ZodType } from 'zod';

export class HelloAgentsError extends Error {
  public constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class LLMError extends HelloAgentsError {}
export class LLMAbortError extends LLMError {}
export class LLMTimeoutError extends LLMAbortError {}
export class AgentError extends HelloAgentsError {}
export class ConfigError extends HelloAgentsError {}
export class ToolError extends HelloAgentsError {}
export class SkillError extends HelloAgentsError {}

type ErrorConstructor = new (message: string, cause?: unknown) => HelloAgentsError;

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
