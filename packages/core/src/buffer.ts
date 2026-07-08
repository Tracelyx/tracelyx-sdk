import type { SpanPayload } from './types.js';

const MAX_BUFFER_SIZE = 100;
const MAX_PENDING = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

export class SpanBuffer {
  private readonly pending: SpanPayload[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  // serializes concurrent drain() calls — prevents race condition on splice()
  private drainingPromise: Promise<void> | null = null;
  private overflowWarned = false;

  constructor(
    private readonly sender: (spans: SpanPayload[]) => Promise<void>,
    private readonly flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  ) {}

  add(span: SpanPayload): void {
    if (this.stopped) return;
    this.pending.push(span);
    if (this.pending.length > MAX_PENDING) {
      this.pending.shift(); // drop-oldest
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        console.warn(
          `[Tracelyx] Span buffer exceeded ${MAX_PENDING} pending spans; ` +
            'dropping oldest. Ingest endpoint may be unreachable.',
        );
      }
    }
    if (this.pending.length >= MAX_BUFFER_SIZE) {
      void this.drain();
    } else {
      this.scheduleFlush();
    }
  }

  drain(): Promise<void> {
    if (this.drainingPromise) return this.drainingPromise;
    if (this.pending.length === 0) return Promise.resolve();

    this.drainingPromise = this.runDrain().finally(() => {
      this.drainingPromise = null;
    });
    return this.drainingPromise;
  }

  // call drain() before stop() to flush any remaining spans
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleFlush(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain().then(() => {
        if (this.pending.length > 0) this.scheduleFlush();
      });
    }, this.flushIntervalMs);
    if (this.timer && typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  private async runDrain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, MAX_BUFFER_SIZE);
      try {
        await this.sender(batch);
      } catch {
        // silent drop — caller (TracelyxClient) handles retries at the HTTP layer
      }
    }
  }
}
