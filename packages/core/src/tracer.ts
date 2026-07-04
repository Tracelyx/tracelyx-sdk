import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { classifyError } from './errors.js';
import type { SpanKind, SpanPayload, TraceSpanOptions } from './types.js';

export function parseTraceparent(header: string): { traceId: string; parentSpanId: string } | null {
  const parts = header.trim().split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, parentSpanId, flags] = parts;
  if (version !== '00') return null;
  if (!/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (!/^[0-9a-f]{16}$/.test(parentSpanId)) return null;
  if (!/^[0-9a-f]{2}$/.test(flags)) return null;
  if (traceId === '0'.repeat(32)) return null;
  if (parentSpanId === '0'.repeat(16)) return null;
  return { traceId, parentSpanId };
}

interface SpanContext {
  spanId: string;
  traceId: string;
  tenantId?: string;
  /**
   * Per-run collector for agent handoff targets. Owned by the active
   * agent/runner span so tool spans can attribute a `transfer_to_*` call to the
   * correct run without a Set shared across concurrent runs of one instance.
   */
  handoffTargets?: Set<string>;
}

const storage = new AsyncLocalStorage<SpanContext>();

export function getActiveContext(): SpanContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(
  ctx: SpanContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export class Span {
  readonly id = randomUUID();
  private status: 'ok' | 'error' = 'ok';
  private readonly attrs: Record<string, unknown> = {};
  private readonly startTime = Date.now();
  private ended = false;

  constructor(
    readonly name: string,
    readonly kind: SpanKind,
    readonly traceId: string,
    readonly parentSpanId: string | null,
    private readonly onEnd: (payload: SpanPayload) => void,
  ) {}

  setAttribute(key: string, value: unknown): void {
    this.attrs[key] = value;
  }

  recordError(error: Error): void {
    this.status = 'error';
    this.attrs['error.message'] = error.message;
    this.attrs['error.stack'] = error.stack ?? '';
    this.attrs['error.name'] = error.name;
    this.attrs['error.type'] = classifyError(error);
  }

  end(attributes?: Record<string, unknown>, options?: { stateSnapshot?: string }): void {
    if (this.ended) return;
    this.ended = true;
    if (attributes) Object.assign(this.attrs, attributes);
    const endTime = Date.now();
    this.onEnd({
      id: this.id,
      traceId: this.traceId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      endTime,
      durationMs: endTime - this.startTime,
      status: this.status,
      attributes: { ...this.attrs },
      stateSnapshot: options?.stateSnapshot,
    });
  }
}

const NOOP_SPAN = {
  setAttribute: (_key: string, _value: unknown) => {},
  recordError: (_error: Error) => {},
  end: (_attributes?: Record<string, unknown>, _options?: { stateSnapshot?: string }) => {},
} as unknown as Span;

export class Trace {
  readonly id: string;
  // name is stored for future per-trace ingestion (v1 batched API does not transmit it)
  readonly name: string;
  private readonly externalParentSpanId: string | null;

  constructor(
    private readonly onSpan: ((payload: SpanPayload) => void) | null,
    readonly tenantId?: string,
    name = '',
    traceparent?: string,
  ) {
    const external = traceparent ? parseTraceparent(traceparent) : null;
    this.id = onSpan ? (external?.traceId ?? randomUUID()) : '';
    this.name = name;
    this.externalParentSpanId = external?.parentSpanId ?? null;
  }

  startSpan(name: string, kind: SpanKind = 'custom'): Span {
    if (!this.onSpan) return NOOP_SPAN;
    const context = storage.getStore();
    const parentSpanId = context?.spanId ?? this.externalParentSpanId;
    const { tenantId } = this;
    return new Span(name, kind, this.id, parentSpanId, (payload) =>
      this.onSpan!({ ...payload, tenantId }),
    );
  }

  async trace<T>(
    name: string,
    fn: () => Promise<T>,
    options: TraceSpanOptions = {},
  ): Promise<T> {
    if (!this.onSpan) return fn();

    const span = this.startSpan(name, options.kind ?? 'custom');
    if (options.attributes) {
      for (const [k, v] of Object.entries(options.attributes)) {
        span.setAttribute(k, v);
      }
    }

    const endOptions = options.stateSnapshot ? { stateSnapshot: options.stateSnapshot } : undefined;
    try {
      const result = await storage.run({ spanId: span.id, traceId: this.id, tenantId: this.tenantId }, fn);
      span.end(undefined, endOptions);
      return result;
    } catch (error) {
      if (error instanceof Error) span.recordError(error);
      span.end(undefined, endOptions);
      throw error;
    }
  }
}
