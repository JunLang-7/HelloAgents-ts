# Streaming and SSE guide

LLM text streaming returns `AsyncIterable<string>`:

```ts
for await (const chunk of llm.stream([{ role: 'user', content: 'Stream a short poem.' }])) {
  process.stdout.write(chunk);
}
```

Agent lifecycle streams return `AsyncIterable<AgentEvent>`. Convert those
events with `streamToSse` or `streamToJsonLines` when serving a web client.
Pass an `AbortSignal` through invocation options to stop an in-flight request;
the adapter and stream close without publishing incomplete final stats.
