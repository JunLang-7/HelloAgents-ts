# Tool response protocol

Every tool call resolves to a `ToolResponse` with `success`, `partial`, or
`error` status. The response carries model-readable text, structured data, and
optional error code, stats, and context:

```ts
const response = await tools.execute('Calculator', { expression: '2 + 2' });
if (response.status === 'error') {
  console.error(response.errorInfo?.code, response.text);
}
```

Framework failures such as invalid registration may throw `ToolError`. Runtime
tool failures become error responses with stable codes such as `NOT_FOUND`,
`INVALID_PARAM`, `CONFLICT`, or `INTERNAL_ERROR`, so an agent can recover.
