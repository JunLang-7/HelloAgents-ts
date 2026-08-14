/** Standard error codes carried by the Python V1 tool protocol. */
export const ToolErrorCode = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  ACCESS_DENIED: 'ACCESS_DENIED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  IS_DIRECTORY: 'IS_DIRECTORY',
  BINARY_FILE: 'BINARY_FILE',
  INVALID_PARAM: 'INVALID_PARAM',
  INVALID_FORMAT: 'INVALID_FORMAT',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  CONFLICT: 'CONFLICT',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  NETWORK_ERROR: 'NETWORK_ERROR',
  API_ERROR: 'API_ERROR',
  RATE_LIMIT: 'RATE_LIMIT'
});

export type ToolErrorCode = (typeof ToolErrorCode)[keyof typeof ToolErrorCode];

export function getAllToolErrorCodes(): readonly ToolErrorCode[] {
  return Object.values(ToolErrorCode);
}

export function isToolErrorCode(value: string): value is ToolErrorCode {
  return getAllToolErrorCodes().includes(value as ToolErrorCode);
}
