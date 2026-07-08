import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanBuffer } from '../src/buffer.js';
import type { SpanPayload } from '../src/types.js';

function makeSpan(id: string): SpanPayload {
  return {
    id,
    traceId: 'trace-1',
    parentSpanId: null,
    name: 'test-span',
    kind: 'custom',
    startTime: Date.now(),
    endTime: Date.now(),
    durationMs: 0,
    status: 'ok',
    attributes: {},
  };
}

describe('SpanBuffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes when 100 spans are added', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    const buffer = new SpanBuffer(sender, 60_000);

    for (let i = 0; i < 100; i++) buffer.add(makeSpan(`span-${i}`));
    await vi.runAllTimersAsync();

    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0][0]).toHaveLength(100);
    buffer.stop();
  });

  it('flushes on interval', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    const buffer = new SpanBuffer(sender, 5_000);

    buffer.add(makeSpan('s1'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sender).toHaveBeenCalledOnce();
    buffer.stop();
  });

  it('does not flush when empty', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    const buffer = new SpanBuffer(sender, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sender).not.toHaveBeenCalled();
    buffer.stop();
  });

  it('drain sends all pending spans and clears the buffer', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    const buffer = new SpanBuffer(sender, 60_000);

    buffer.add(makeSpan('s1'));
    buffer.add(makeSpan('s2'));
    await buffer.drain();

    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0][0]).toHaveLength(2);

    // buffer is empty now — second drain should not call sender
    await buffer.drain();
    expect(sender).toHaveBeenCalledOnce();
    buffer.stop();
  });

  it('drain() flushes ALL pending spans across multiple batches, not just the first 100', async () => {
    const sent: number[] = [];
    const sender = vi.fn().mockImplementation(async (spans: unknown[]) => { sent.push(spans.length); });
    const buffer = new SpanBuffer(sender, 5_000);

    for (let i = 0; i < 250; i++) {
      (buffer as unknown as { pending: unknown[] }).pending.push({ id: String(i) });
    }
    await buffer.drain();

    expect(sent.reduce((a, b) => a + b, 0)).toBe(250); // wszystkie 250, nie 100
    expect((buffer as unknown as { pending: unknown[] }).pending).toHaveLength(0);
  });
});
