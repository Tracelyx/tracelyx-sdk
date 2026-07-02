import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHookCommand } from '../../bin/tracelyx.js';
import type { TracePayload } from '../../src/types.js';

describe('hook command', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response('{"accepted":1}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends a hook span with correct attributes', async () => {
    vi.stubEnv('TRACELYX_API_KEY', 'tl_test');
    vi.stubEnv('TRACELYX_PROJECT_ID', 'proj_1');

    const hookData = {
      session_id: 'sess-abc',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };

    await runHookCommand(['--event', 'PreToolUse'], JSON.stringify(hookData));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans[0];

    expect(span.kind).toBe('hook');
    expect(span.name).toBe('hook.PreToolUse');
    expect(span.traceId).toBe('sess-abc');
    expect(span.parentSpanId).toBeNull();
    expect(span.attributes['hook.tool_name']).toBe('Bash');
    expect(span.attributes['hook.session_id']).toBe('sess-abc');
    expect(span.attributes['hook.original_input']).toBe(JSON.stringify({ command: 'ls' }));
  });

  it('exits silently (no fetch) when API key is not configured', async () => {
    vi.stubEnv('TRACELYX_API_KEY', '');
    vi.stubEnv('TRACELYX_PROJECT_ID', '');

    await runHookCommand(['--event', 'PreToolUse'], '{}');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits silently when stdin is invalid JSON', async () => {
    vi.stubEnv('TRACELYX_API_KEY', 'tl_test');
    vi.stubEnv('TRACELYX_PROJECT_ID', 'proj_1');

    await expect(runHookCommand(['--event', 'Stop'], 'not-json')).resolves.not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('generates random traceId when session_id is absent', async () => {
    vi.stubEnv('TRACELYX_API_KEY', 'tl_test');
    vi.stubEnv('TRACELYX_PROJECT_ID', 'proj_1');

    await runHookCommand(['--event', 'PostToolUse'], '{}');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('sets durationMs from execution_ms when present in hookData', async () => {
    vi.stubEnv('TRACELYX_API_KEY', 'tl_test');
    vi.stubEnv('TRACELYX_PROJECT_ID', 'proj_1');

    const stdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Read',
      execution_ms: 42,
    });

    await runHookCommand(['--event', 'PostToolUse'], stdin);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].durationMs).toBe(42);
    expect(body.spans[0].attributes['hook.execution_ms']).toBe(42);
  });

  it('sets hook.error from tool_error when present', async () => {
    vi.stubEnv('TRACELYX_API_KEY', 'tl_test');
    vi.stubEnv('TRACELYX_PROJECT_ID', 'proj_1');

    const stdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_error: 'permission denied',
    });

    await runHookCommand(['--event', 'PostToolUse'], stdin);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].attributes['hook.error']).toBe('permission denied');
  });

  it('sets hook.modified_input when modified_input is present', async () => {
    vi.stubEnv('TRACELYX_API_KEY', 'tl_test');
    vi.stubEnv('TRACELYX_PROJECT_ID', 'proj_1');

    const stdin = JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Write',
      tool_input: { path: '/tmp/file.txt', content: 'original' },
      modified_input: { path: '/tmp/file.txt', content: 'sanitized' },
    });

    await runHookCommand(['--event', 'PreToolUse'], stdin);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].attributes['hook.modified_input']).toBe(
      JSON.stringify({ path: '/tmp/file.txt', content: 'sanitized' }),
    );
  });

  it('sets error.type=hook_error and status=error when tool_error present', async () => {
    vi.stubEnv('TRACELYX_API_KEY', 'tl_test');
    vi.stubEnv('TRACELYX_PROJECT_ID', 'proj_1');

    await runHookCommand(
      ['--event', 'PostToolUse'],
      JSON.stringify({ session_id: 's-1', tool_name: 'Bash', tool_error: 'command not found' }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].status).toBe('error');
    expect(body.spans[0].attributes['error.type']).toBe('hook_error');
    expect(body.spans[0].attributes['hook.error']).toBe('command not found');
  });
});
