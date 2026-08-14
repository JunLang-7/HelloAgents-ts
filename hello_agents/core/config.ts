import { z } from 'zod';

import { parseOrThrow } from './errors.js';

const configFields = {
  defaultModel: z.string().min(1).default('gpt-3.5-turbo'),
  defaultProvider: z.string().min(1).default('openai'),
  temperature: z.number().finite().default(0.7),
  maxTokens: z.number().int().positive().nullable().default(null),
  debug: z.boolean().default(false),
  logLevel: z.string().min(1).default('INFO'),
  maxHistoryLength: z.number().int().positive().default(100),
  contextWindow: z.number().int().positive().default(128_000),
  compressionThreshold: z.number().finite().min(0).max(1).default(0.8),
  minRetainRounds: z.number().int().nonnegative().default(10),
  enableSmartCompression: z.boolean().default(false),
  summaryLlmProvider: z.string().min(1).default('deepseek'),
  summaryLlmModel: z.string().min(1).default('deepseek-chat'),
  summaryMaxTokens: z.number().int().positive().default(800),
  summaryTemperature: z.number().finite().default(0.3),
  toolOutputMaxLines: z.number().int().positive().default(2000),
  toolOutputMaxBytes: z.number().int().positive().default(51_200),
  toolOutputDir: z.string().min(1).default('tool-output'),
  toolOutputTruncateDirection: z.enum(['head', 'tail', 'head_tail']).default('head'),
  traceEnabled: z.boolean().default(true),
  traceDir: z.string().min(1).default('memory/traces'),
  traceSanitize: z.boolean().default(true),
  traceHtmlIncludeRawResponse: z.boolean().default(false),
  skillsEnabled: z.boolean().default(true),
  skillsDir: z.string().min(1).default('skills'),
  skillsAutoRegister: z.boolean().default(true),
  circuitEnabled: z.boolean().default(true),
  circuitFailureThreshold: z.number().int().positive().default(3),
  circuitRecoveryTimeout: z.number().int().positive().default(300),
  sessionEnabled: z.boolean().default(true),
  sessionDir: z.string().min(1).default('memory/sessions'),
  autoSaveEnabled: z.boolean().default(false),
  autoSaveInterval: z.number().int().positive().default(10),
  subagentEnabled: z.boolean().default(true),
  subagentMaxSteps: z.number().int().positive().default(15),
  subagentUseLightLlm: z.boolean().default(false),
  subagentLightLlmProvider: z.string().min(1).default('deepseek'),
  subagentLightLlmModel: z.string().min(1).default('deepseek-chat'),
  todowriteEnabled: z.boolean().default(true),
  todowritePersistenceDir: z.string().min(1).default('memory/todos'),
  devlogEnabled: z.boolean().default(true),
  devlogPersistenceDir: z.string().min(1).default('memory/devlogs'),
  asyncEnabled: z.boolean().default(true),
  maxConcurrentTools: z.number().int().positive().default(3),
  hookTimeoutSeconds: z.number().finite().positive().default(5),
  llmAsyncTimeout: z.number().int().positive().default(120),
  toolAsyncTimeout: z.number().int().positive().default(30),
  streamEnabled: z.boolean().default(true),
  streamBufferSize: z.number().int().positive().default(100),
  streamIncludeThinking: z.boolean().default(true),
  streamIncludeToolCalls: z.boolean().default(true)
} as const;

/** Validates the camelCase runtime configuration accepted by the TypeScript API. */
export const configSchema = z.object(configFields).strict();
/** Input configuration; omitted fields receive the documented runtime defaults. */
export type ConfigInput = z.input<typeof configSchema>;
/** Fully resolved configuration with defaults applied. */
export type ConfigValues = z.output<typeof configSchema>;

const wireNameMap = {
  defaultModel: 'default_model',
  defaultProvider: 'default_provider',
  temperature: 'temperature',
  maxTokens: 'max_tokens',
  debug: 'debug',
  logLevel: 'log_level',
  maxHistoryLength: 'max_history_length',
  contextWindow: 'context_window',
  compressionThreshold: 'compression_threshold',
  minRetainRounds: 'min_retain_rounds',
  enableSmartCompression: 'enable_smart_compression',
  summaryLlmProvider: 'summary_llm_provider',
  summaryLlmModel: 'summary_llm_model',
  summaryMaxTokens: 'summary_max_tokens',
  summaryTemperature: 'summary_temperature',
  toolOutputMaxLines: 'tool_output_max_lines',
  toolOutputMaxBytes: 'tool_output_max_bytes',
  toolOutputDir: 'tool_output_dir',
  toolOutputTruncateDirection: 'tool_output_truncate_direction',
  traceEnabled: 'trace_enabled',
  traceDir: 'trace_dir',
  traceSanitize: 'trace_sanitize',
  traceHtmlIncludeRawResponse: 'trace_html_include_raw_response',
  skillsEnabled: 'skills_enabled',
  skillsDir: 'skills_dir',
  skillsAutoRegister: 'skills_auto_register',
  circuitEnabled: 'circuit_enabled',
  circuitFailureThreshold: 'circuit_failure_threshold',
  circuitRecoveryTimeout: 'circuit_recovery_timeout',
  sessionEnabled: 'session_enabled',
  sessionDir: 'session_dir',
  autoSaveEnabled: 'auto_save_enabled',
  autoSaveInterval: 'auto_save_interval',
  subagentEnabled: 'subagent_enabled',
  subagentMaxSteps: 'subagent_max_steps',
  subagentUseLightLlm: 'subagent_use_light_llm',
  subagentLightLlmProvider: 'subagent_light_llm_provider',
  subagentLightLlmModel: 'subagent_light_llm_model',
  todowriteEnabled: 'todowrite_enabled',
  todowritePersistenceDir: 'todowrite_persistence_dir',
  devlogEnabled: 'devlog_enabled',
  devlogPersistenceDir: 'devlog_persistence_dir',
  asyncEnabled: 'async_enabled',
  maxConcurrentTools: 'max_concurrent_tools',
  hookTimeoutSeconds: 'hook_timeout_seconds',
  llmAsyncTimeout: 'llm_async_timeout',
  toolAsyncTimeout: 'tool_async_timeout',
  streamEnabled: 'stream_enabled',
  streamBufferSize: 'stream_buffer_size',
  streamIncludeThinking: 'stream_include_thinking',
  streamIncludeToolCalls: 'stream_include_tool_calls'
} as const satisfies Record<keyof ConfigValues, string>;

const configWireSchema = z
  .object(
    Object.fromEntries(
      Object.entries(wireNameMap).map(([camelCase, snakeCase]) => [
        snakeCase,
        configFields[camelCase as keyof typeof configFields]
      ])
    ) as Record<string, z.ZodType>
  )
  .partial()
  .strict();

export class Config {
  /** Wraps already-resolved configuration values for wire serialization. */
  public constructor(private readonly values: ConfigValues) {}
  /** Serializes camelCase settings to the snake_case session/config wire format. */
  public toJSON(): Record<string, ConfigValues[keyof ConfigValues]> {
    return Object.fromEntries(
      Object.entries(wireNameMap).map(([key, wire]) => [
        wire,
        this.values[key as keyof ConfigValues]
      ])
    );
  }
}
export type ResolvedConfig = Config & ConfigValues;

/** Validates camelCase input and returns a frozen configuration with defaults. */
export function createConfig(input: ConfigInput = {}): ResolvedConfig {
  const values = parseOrThrow(configSchema, input, 'Config');
  const config = new Config(values) as ResolvedConfig;
  Object.assign(config, values);
  Object.freeze(config);
  return config;
}

/** Parses the snake_case wire representation used by Python-compatible data files. */
export function parseConfig(input: unknown): ResolvedConfig {
  const wire = parseOrThrow(configWireSchema, input, 'Config');
  const camelCaseInput = Object.fromEntries(
    Object.entries(wireNameMap).flatMap(([camelCase, snakeCase]) => {
      const value = wire[snakeCase];
      return value === undefined ? [] : [[camelCase, value]];
    })
  ) as ConfigInput;
  return createConfig(camelCaseInput);
}

/** Builds configuration from the supported environment variables and defaults. */
export function createConfigFromEnv(env: Record<string, string | undefined>): ResolvedConfig {
  const input: ConfigInput = {
    debug: (env.DEBUG ?? 'false').toLowerCase() === 'true',
    logLevel: env.LOG_LEVEL ?? 'INFO',
    temperature: Number(env.TEMPERATURE ?? '0.7'),
    maxTokens: env.MAX_TOKENS === undefined || env.MAX_TOKENS === '' ? null : Number(env.MAX_TOKENS)
  };
  return createConfig(input);
}
