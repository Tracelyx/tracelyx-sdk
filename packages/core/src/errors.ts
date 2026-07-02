/** Matches ErrorType enum in @tracelyx/shared (TASK-221). */
export type ErrorType =
  | 'tool_timeout'
  | 'context_window_exceeded'
  | 'json_parse_error'
  | 'rate_limit'
  | 'network_error'
  | 'hook_error'
  | 'unknown';

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']);

export function classifyError(error: unknown): ErrorType {
  if (error instanceof SyntaxError) return 'json_parse_error';
  if (error === null || typeof error !== 'object') return 'unknown';

  const err = error as { name?: string; message?: string; status?: number; code?: string };
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';

  if (err.status === 429 || message.includes('rate limit') || message.includes('too many requests')) {
    return 'rate_limit';
  }
  if (
    message.includes('context window') ||
    message.includes('context length') ||
    message.includes('prompt is too long')
  ) {
    return 'context_window_exceeded';
  }
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || message.includes('timed out') || message.includes('timeout')) {
    return 'tool_timeout';
  }
  if ((err.code !== undefined && NETWORK_CODES.has(err.code)) || message.includes('fetch failed') || message.includes('network')) {
    return 'network_error';
  }
  return 'unknown';
}
