import { describe, it, expect, vi } from 'vitest';
import { Trace, Span, getActiveContext } from '../src/tracer.js';
import type { SpanPayload } from '../src/types.js';

describe('Span', () => {
  it('records name, kind, attributes and status ok on end', () => {
    const captured: SpanPayload[] = [];
    const span = new Span('test-span', 'llm_call', 'trace-1', null, (p) =>
      captured.push(p),
    );

    span.setAttribute('llm.model', 'claude-sonnet-4-6');
    span.end({ 'llm.prompt_tokens': 150 });

    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe('test-span');
    expect(captured[0].kind).toBe('llm_call');
    expect(captured[0].status).toBe('ok');
    expect(captured[0].attributes).toMatchObject({
      'llm.model': 'claude-sonnet-4-6',
      'llm.prompt_tokens': 150,
    });
    expect(captured[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(captured[0].parentSpanId).toBeNull();
  });

  it('records error status and message on recordError', () => {
    const captured: SpanPayload[] = [];
    const span = new Span('step', 'custom', 'trace-1', null, (p) =>
      captured.push(p),
    );

    span.recordError(new Error('something broke'));
    span.end();

    expect(captured[0].status).toBe('error');
    expect(captured[0].attributes['error.message']).toBe('something broke');
    expect(typeof captured[0].attributes['error.stack']).toBe('string');
  });

  it('recordError sets error.type attribute from classifyError', async () => {
    const spans: SpanPayload[] = [];
    const trace = new Trace((p) => spans.push(p));
    const span = trace.startSpan('failing-step', 'tool_call');

    span.recordError(Object.assign(new Error('Request failed'), { status: 429 }));
    span.end();

    expect(spans[0].status).toBe('error');
    expect(spans[0].attributes['error.type']).toBe('rate_limit');
  });
});

describe('Trace', () => {
  it('startSpan creates span with traceId and no parent at top level', () => {
    const captured: SpanPayload[] = [];
    const trace = new Trace((p) => captured.push(p));

    const span = trace.startSpan('root-span', 'agent_step');
    span.end();

    expect(captured[0].traceId).toBe(trace.id);
    expect(captured[0].parentSpanId).toBeNull();
  });

  it('trace() propagates parentSpanId via AsyncLocalStorage', async () => {
    const captured: SpanPayload[] = [];
    const trace = new Trace((p) => captured.push(p));

    await trace.trace('parent-step', async () => {
      const child = trace.startSpan('child-span', 'tool_call');
      child.end();
    });

    const parent = captured.find((s) => s.name === 'parent-step')!;
    const child = captured.find((s) => s.name === 'child-span')!;

    expect(parent).toBeDefined();
    expect(child.parentSpanId).toBe(parent.id);
  });

  it('trace() captures thrown error, marks span as error, and re-throws', async () => {
    const captured: SpanPayload[] = [];
    const trace = new Trace((p) => captured.push(p));

    await expect(
      trace.trace('failing-step', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(captured[0].status).toBe('error');
    expect(captured[0].attributes['error.message']).toBe('boom');
  });

  it('trace.trace() sets error.type when wrapped fn throws', async () => {
    const spans: SpanPayload[] = [];
    const trace = new Trace((p) => spans.push(p));

    await expect(
      trace.trace('step', async () => {
        throw new Error('Request timed out after 5000ms');
      }),
    ).rejects.toThrow('timed out');

    expect(spans[0].attributes['error.type']).toBe('tool_timeout');
  });

  it('noop trace (null onSpan) calls fn but records no spans', async () => {
    const trace = new Trace(null);
    const fn = vi.fn().mockResolvedValue('result');

    const result = await trace.trace('step', fn);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('noop trace startSpan returns a span that does not throw on end', () => {
    const trace = new Trace(null);
    const span = trace.startSpan('step', 'custom');

    expect(() => span.end()).not.toThrow();
  });

  it('getActiveContext returns undefined outside of trace()', () => {
    expect(getActiveContext()).toBeUndefined();
  });

  it('getActiveContext returns spanId and traceId inside trace()', async () => {
    let captured: { spanId: string; traceId: string } | undefined;
    const trace = new Trace((_p) => {});

    await trace.trace('step', async () => {
      captured = getActiveContext();
    });

    expect(captured).toBeDefined();
    expect(captured!.traceId).toBe(trace.id);
    expect(captured!.spanId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('propagates parent span context through Promise.all branches', async () => {
    const spans: SpanPayload[] = [];
    const trace = new Trace((p) => spans.push(p));

    await trace.trace('parent', async () => {
      await Promise.all([
        trace.trace('branch-a', async () => {}),
        trace.trace('branch-b', async () => {}),
      ]);
    });

    const parent = spans.find((s) => s.name === 'parent')!;
    const branchA = spans.find((s) => s.name === 'branch-a')!;
    const branchB = spans.find((s) => s.name === 'branch-b')!;

    expect(parent).toBeDefined();
    expect(branchA.parentSpanId).toBe(parent.id);
    expect(branchB.parentSpanId).toBe(parent.id);
    expect(branchA.traceId).toBe(trace.id);
    expect(branchB.traceId).toBe(trace.id);
  });

  describe('stateSnapshot', () => {
    it('span.end() with stateSnapshot includes it in SpanPayload', () => {
      const spans: SpanPayload[] = [];
      const trace = new Trace((p) => spans.push(p));
      const span = trace.startSpan('step', 'agent_step');
      span.end(undefined, { stateSnapshot: '{"key":"value"}' });

      expect(spans[0].stateSnapshot).toBe('{"key":"value"}');
    });

    it('trace.trace() propagates stateSnapshot from options to SpanPayload', async () => {
      const spans: SpanPayload[] = [];
      const trace = new Trace((p) => spans.push(p));
      await trace.trace('step', async () => {}, { stateSnapshot: '{"node":"a"}' });

      expect(spans[0].stateSnapshot).toBe('{"node":"a"}');
    });

    it('span.end() without stateSnapshot leaves field undefined', () => {
      const spans: SpanPayload[] = [];
      const trace = new Trace((p) => spans.push(p));
      const span = trace.startSpan('step', 'agent_step');
      span.end();

      expect(spans[0].stateSnapshot).toBeUndefined();
    });
  });
});
