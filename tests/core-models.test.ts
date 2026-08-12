import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/python-v1-core-wire.json' with { type: 'json' };

import {
  AgentEvent,
  AgentError,
  ConfigError,
  ExecutionContext,
  LLMError,
  Message,
  createConfig,
  createConfigFromEnv,
  parseConfig,
  parseLLMResponse,
  parseLLMToolResponse,
  parseSessionData,
  parseStreamStats
} from '../src/index.js';

test('parses the versioned Python V1 core wire fixture without field renaming', () => {
  const message = Message.fromJSON(fixture.message);
  const response = parseLLMResponse(fixture.response);
  const event = AgentEvent.fromJSON(fixture.event);

  expect(JSON.stringify(message.toJSON())).toBe(JSON.stringify(fixture.message));
  expect(JSON.stringify(response.toJSON())).toBe(JSON.stringify(fixture.response));
  expect(JSON.stringify(event.toJSON())).toBe(JSON.stringify(fixture.event));
});

describe('Config', () => {
  test('uses every Python V1 default and serializes config as snake_case', () => {
    const config = createConfig();

    expect(config.toJSON()).toEqual({
      default_model: 'gpt-3.5-turbo',
      default_provider: 'openai',
      temperature: 0.7,
      max_tokens: null,
      debug: false,
      log_level: 'INFO',
      max_history_length: 100,
      context_window: 128_000,
      compression_threshold: 0.8,
      min_retain_rounds: 10,
      enable_smart_compression: false,
      summary_llm_provider: 'deepseek',
      summary_llm_model: 'deepseek-chat',
      summary_max_tokens: 800,
      summary_temperature: 0.3,
      tool_output_max_lines: 2000,
      tool_output_max_bytes: 51_200,
      tool_output_dir: 'tool-output',
      tool_output_truncate_direction: 'head',
      trace_enabled: true,
      trace_dir: 'memory/traces',
      trace_sanitize: true,
      trace_html_include_raw_response: false,
      skills_enabled: true,
      skills_dir: 'skills',
      skills_auto_register: true,
      circuit_enabled: true,
      circuit_failure_threshold: 3,
      circuit_recovery_timeout: 300,
      session_enabled: true,
      session_dir: 'memory/sessions',
      auto_save_enabled: false,
      auto_save_interval: 10,
      subagent_enabled: true,
      subagent_max_steps: 15,
      subagent_use_light_llm: false,
      subagent_light_llm_provider: 'deepseek',
      subagent_light_llm_model: 'deepseek-chat',
      todowrite_enabled: true,
      todowrite_persistence_dir: 'memory/todos',
      devlog_enabled: true,
      devlog_persistence_dir: 'memory/devlogs',
      async_enabled: true,
      max_concurrent_tools: 3,
      hook_timeout_seconds: 5,
      llm_async_timeout: 120,
      tool_async_timeout: 30,
      stream_enabled: true,
      stream_buffer_size: 100,
      stream_include_thinking: true,
      stream_include_tool_calls: true
    });
  });

  test('applies Python environment precedence and converts invalid input into ConfigError', () => {
    const config = createConfigFromEnv({
      DEBUG: 'TRUE',
      LOG_LEVEL: 'DEBUG',
      TEMPERATURE: '0.2',
      MAX_TOKENS: '512'
    });

    expect(config).toMatchObject({
      debug: true,
      logLevel: 'DEBUG',
      temperature: 0.2,
      maxTokens: 512
    });
    expect(() => createConfig({ maxConcurrentTools: 0 })).toThrow(ConfigError);
    expect(() => createConfigFromEnv({ TEMPERATURE: 'not-a-number' })).toThrow(ConfigError);
  });

  test('round-trips Python snake_case config JSON through a validated immutable value', () => {
    const config = parseConfig({
      default_model: 'gpt-test',
      max_tokens: 12,
      trace_enabled: false,
      stream_buffer_size: 2
    });

    expect(config).toMatchObject({
      defaultModel: 'gpt-test',
      maxTokens: 12,
      traceEnabled: false,
      streamBufferSize: 2
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => parseConfig({ default_model: '' })).toThrow(ConfigError);
  });
});

describe('Message', () => {
  test('round-trips Python wire fields and renders its Python text form', () => {
    const message = Message.fromJSON({
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-08-12T12:34:56.000Z',
      metadata: { source: 'test' }
    });

    expect(message.timestamp).toBeInstanceOf(Date);
    expect(message.toText()).toBe('[assistant] hello');
    expect(message.toJSON()).toEqual({
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-08-12T12:34:56.000Z',
      metadata: { source: 'test' }
    });
  });

  test('accepts Python datetime.isoformat output without a timezone suffix', () => {
    const message = Message.fromJSON({
      role: 'user',
      content: 'naive timestamp',
      timestamp: '2026-08-12T12:34:56.123456',
      metadata: {}
    });

    expect(message.timestamp).toBeInstanceOf(Date);
  });

  test('normalizes schema failures instead of leaking Zod errors', () => {
    let error: unknown;
    try {
      Message.fromJSON({ role: 'invalid', content: 42 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect(error).not.toHaveProperty('issues');
  });
});

describe('LLM response models', () => {
  test('keeps Python snake_case fields and omits empty reasoning content', () => {
    const response = parseLLMResponse({
      content: 'answer',
      model: 'test-model',
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      latency_ms: 12,
      reasoning_content: ''
    });
    const toolResponse = parseLLMToolResponse({
      content: null,
      tool_calls: [{ id: 'call_1', name: 'calculate', arguments: '{"value":2}' }],
      model: 'test-model'
    });
    const streamStats = parseStreamStats({ model: 'test-model' });

    expect(response.toJSON()).toEqual({
      content: 'answer',
      model: 'test-model',
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      latency_ms: 12
    });
    expect(toolResponse.toJSON()).toEqual({
      content: null,
      tool_calls: [{ id: 'call_1', name: 'calculate', arguments: '{"value":2}' }],
      model: 'test-model',
      usage: {},
      latency_ms: 0
    });
    expect(streamStats.toJSON()).toEqual({ model: 'test-model', usage: {}, latency_ms: 0 });
    expect(() => parseLLMResponse({ model: 'missing-content' })).toThrow(LLMError);
  });
});

describe('Lifecycle and session wire models', () => {
  test('creates events and execution contexts with Python-compatible fields', () => {
    const event = AgentEvent.create('tool_call', 'researcher', {
      tool_name: 'search',
      tool_args: { query: 'HelloAgents' }
    });
    const context = new ExecutionContext('question');
    context.incrementStep();
    context.addTokens(8);
    context.setMetadata('requestId', 'r1');

    expect(event.toJSON()).toMatchObject({
      type: 'tool_call',
      agent_name: 'researcher',
      data: { tool_name: 'search', tool_args: { query: 'HelloAgents' } }
    });
    expect(context.toJSON()).toEqual({
      input_text: 'question',
      current_step: 1,
      total_tokens: 8,
      metadata: { requestId: 'r1' }
    });
    expect(() => AgentEvent.fromJSON({ type: 'unknown' })).toThrow(AgentError);
  });

  test('validates persisted session wire data before it reaches a future SessionStore', () => {
    const session = parseSessionData({
      session_id: 's-20260812-12345678',
      created_at: '2026-08-12T12:00:00.000Z',
      saved_at: '2026-08-12T12:01:00.000Z',
      agent_config: { name: 'assistant' },
      history: [
        { role: 'user', content: 'hello', timestamp: '2026-08-12T12:00:00.000Z', metadata: {} }
      ],
      tool_schema_hash: 'abc123',
      read_cache: {},
      metadata: { total_tokens: 1 }
    });

    expect(session.sessionId).toBe('s-20260812-12345678');
    expect(session.toJSON().history).toHaveLength(1);
    expect(() => parseSessionData({ session_id: 'missing-everything' })).toThrow(ConfigError);
  });
});
