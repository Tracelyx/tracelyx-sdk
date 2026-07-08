import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TracelyxClient } from '../src/client.js';
import type { SpanPayload, TracePayload } from '../src/types.js';

describe('TracelyxClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends spans to /v1/traces on flush', async () => {
    const client = new TracelyxClient({
      apiKey: 'test-key',
      projectId: 'my-project',
      endpoint: 'http://localhost:8080',
    });

    const trace = client.startTrace({ name: 'run', tenantId: 'acme' });
    const span = trace.startSpan('step', 'custom');
    span.end();

    const flushPromise = client.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('http://localhost:8080/v1/traces');
    expect(init.headers['Authorization']).toBe('Bearer test-key');

    const body = JSON.parse(init.body as string) as {
      projectId: string;
      spans: unknown[];
    };
    expect(body.projectId).toBe('my-project');
    expect(body.spans).toHaveLength(1);
  });

  it('does not send spans when disabled: true', async () => {
    const client = new TracelyxClient({
      apiKey: 'test-key',
      projectId: 'my-project',
      disabled: true,
    });

    const trace = client.startTrace({ name: 'run' });
    trace.startSpan('step', 'custom').end();

    const flushPromise = client.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(fetch).not.toHaveBeenCalled();
  });

  it('silently drops spans after 3 failed fetch attempts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const client = new TracelyxClient({
      apiKey: 'key',
      projectId: 'proj',
      endpoint: 'http://localhost:8080',
    });

    const trace = client.startTrace({ name: 'run' });
    trace.startSpan('step', 'custom').end();

    const flushPromise = client.flush();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(flushPromise).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('uses default endpoint when none is provided', async () => {
    const client = new TracelyxClient({
      apiKey: 'key',
      projectId: 'proj',
    });

    client.startTrace({ name: 'run' }).startSpan('s', 'custom').end();

    const flushPromise = client.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://ingest.tracelyx.dev/v1/traces');
  });

  describe('recordSpan', () => {
    it('adds span directly to buffer and sends on flush', async () => {
      const sentBodies: TracePayload[] = [];
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        sentBodies.push(JSON.parse(init.body as string) as TracePayload);
        return new Response('{"accepted":1}', { status: 200 });
      });

      const client = new TracelyxClient({ apiKey: 'tl_test', projectId: 'proj_1' });
      const span: SpanPayload = {
        id: 'span-direct',
        traceId: 'trace-direct',
        parentSpanId: null,
        name: 'direct-span',
        kind: 'custom',
        startTime: 1000,
        endTime: 1100,
        durationMs: 100,
        status: 'ok',
        attributes: {},
      };

      client.recordSpan(span);
      await client.flush();

      expect(sentBodies).toHaveLength(1);
      expect(sentBodies[0].spans[0].id).toBe('span-direct');
    });

    it('is no-op when disabled', async () => {
      const client = new TracelyxClient({ apiKey: 'tl_test', projectId: 'proj_1', disabled: true });
      client.recordSpan({
        id: 'x',
        traceId: 'y',
        parentSpanId: null,
        name: 'n',
        kind: 'custom',
        startTime: 0,
        endTime: 0,
        durationMs: 0,
        status: 'ok',
        attributes: {},
      });
      await client.flush();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('warns once when a batch is permanently dropped (non-retryable 4xx)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    const client = new TracelyxClient({ apiKey: 'tl_test', projectId: 'proj_1' });

    client.recordSpan({
      id: '1', traceId: 't', parentSpanId: null, name: 'x', kind: 'custom',
      startTime: 0, endTime: 0, durationMs: 0, status: 'ok', attributes: {},
    });
    await client.flush();

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[Tracelyx]'))).toBe(true);
    warn.mockRestore();
    vi.unstubAllGlobals();
  });
});
