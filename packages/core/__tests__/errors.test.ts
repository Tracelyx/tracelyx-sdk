import { describe, it, expect } from 'vitest';
import { classifyError } from '../src/errors.js';

describe('classifyError', () => {
  it('classifies SyntaxError as json_parse_error', () => {
    expect(classifyError(new SyntaxError('Unexpected token'))).toBe('json_parse_error');
  });

  it('classifies HTTP 429 status as rate_limit', () => {
    const err = Object.assign(new Error('Request failed'), { status: 429 });
    expect(classifyError(err)).toBe('rate_limit');
  });

  it('classifies "rate limit" message as rate_limit', () => {
    expect(classifyError(new Error('Anthropic rate limit exceeded'))).toBe('rate_limit');
  });

  it('classifies context window messages as context_window_exceeded', () => {
    expect(classifyError(new Error('prompt is too long: 250000 tokens'))).toBe('context_window_exceeded');
    expect(classifyError(new Error('maximum context length is 128000 tokens'))).toBe('context_window_exceeded');
    expect(classifyError(new Error('context window exceeded'))).toBe('context_window_exceeded');
  });

  it('classifies AbortError / timeout messages as tool_timeout', () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(classifyError(abortErr)).toBe('tool_timeout');
    expect(classifyError(new Error('Request timed out after 30000ms'))).toBe('tool_timeout');
  });

  it('classifies network error codes and fetch failures as network_error', () => {
    const connRefused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyError(connRefused)).toBe('network_error');
    expect(classifyError(new TypeError('fetch failed'))).toBe('network_error');
  });

  it('rate_limit wins over timeout when both signals present (429 + "timeout" in message)', () => {
    const err = Object.assign(new Error('timeout waiting for rate limiter'), { status: 429 });
    expect(classifyError(err)).toBe('rate_limit');
  });

  it('returns unknown for plain errors and non-Error values', () => {
    expect(classifyError(new Error('something odd'))).toBe('unknown');
    expect(classifyError('a string')).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
  });
});
