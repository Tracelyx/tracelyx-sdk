import type {
  TracelyxClientOptions,
  SpanPayload,
  StartTraceOptions,
  TracePayload,
} from './types.js';
import { SpanBuffer } from './buffer.js';
import { Trace } from './tracer.js';
import { OtlpExporter, type OtlpOptions } from './otlp.js';

const DEFAULT_ENDPOINT = 'https://ingest.tracelyx.dev';
const MAX_RETRIES = 3;
const FLUSH_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TracelyxClient {
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly endpoint: string;
  private readonly environment: 'development' | 'staging' | 'production' | undefined;
  private readonly disabled: boolean;
  private readonly buffer: SpanBuffer | null;
  private dropWarned = false;

  constructor(options: TracelyxClientOptions & { otlp?: OtlpOptions }) {
    this.apiKey = options.apiKey;
    this.projectId = options.projectId;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.environment = options.environment;
    this.disabled = options.disabled ?? false;
    if (this.disabled) {
      this.buffer = null;
    } else {
      const otlpExporter = options.otlp ? new OtlpExporter(options.otlp) : null;
      const sender = otlpExporter
        ? async (spans: SpanPayload[]) => {
            await Promise.allSettled([this.sendNative(spans), otlpExporter.send(spans)]);
          }
        : (spans: SpanPayload[]) => this.sendNative(spans);
      this.buffer = new SpanBuffer(sender);
    }
  }

  startTrace(options: StartTraceOptions): Trace {
    if (this.disabled) return new Trace(null, options.tenantId, options.name);
    return new Trace((span) => this.buffer!.add(span), options.tenantId, options.name, options.traceparent);
  }

  public recordSpan(span: SpanPayload): void {
    if (this.disabled || !this.buffer) return;
    this.buffer.add(span);
  }

  /**
   * Flushes all pending spans and permanently stops the client.
   * Any spans added after this call are silently dropped.
   * Intended for process shutdown — call once at exit.
   */
  async flush(): Promise<void> {
    if (!this.buffer) return;
    this.buffer.stop();
    const drain = this.buffer.drain();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      // never let this timer keep the process alive (mirrors SpanBuffer's own timer)
      if (timer && typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
    });
    try {
      await Promise.race([drain, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async sendNative(spans: SpanPayload[]): Promise<void> {
    const groups = new Map<string | undefined, SpanPayload[]>();
    for (const span of spans) {
      const key = span.tenantId;
      const arr = groups.get(key);
      if (arr) arr.push(span);
      else groups.set(key, [span]);
    }
    await Promise.all([...groups.values()].map((group) => this.sendGroup(group)));
  }

  private async sendGroup(spans: SpanPayload[], attempt = 1): Promise<void> {
    const payload: TracePayload = {
      projectId: this.projectId,
      tenantId: spans[0]?.tenantId,
      environment: this.environment,
      spans,
    };
    try {
      const res = await fetch(`${this.endpoint}/v1/traces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        if (retryable && attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** (attempt - 1));
          return this.sendGroup(spans, attempt + 1);
        }
        this.warnDropOnce(`HTTP ${res.status}`);
      }
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** (attempt - 1));
        return this.sendGroup(spans, attempt + 1);
      }
      this.warnDropOnce('network error after retries');
    }
  }

  private warnDropOnce(reason: string): void {
    if (this.dropWarned) return;
    this.dropWarned = true;
    console.warn(`[Tracelyx] Dropping spans permanently (${reason}). Telemetry may be incomplete.`);
  }
}
