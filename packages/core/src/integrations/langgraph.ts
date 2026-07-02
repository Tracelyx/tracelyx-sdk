import { randomUUID } from 'crypto';
import { getActiveContext, runWithContext } from '../tracer.js';
import { classifyError } from '../errors.js';
import type { TracelyxClient } from '../client.js';
import type { SpanPayload } from '../types.js';

const INSTRUMENTED = Symbol('tracelyx.instrumented');

interface LangGraphConfig {
  configurable?: {
    thread_id?: string;
    checkpoint_id?: string;
    [key: string]: unknown;
  };
  streamMode?: string;
  [key: string]: unknown;
}

interface CompiledGraphLike {
  invoke(input: unknown, config?: LangGraphConfig): Promise<unknown>;
  stream?(input: unknown, config?: LangGraphConfig): AsyncIterable<unknown>;
  streamEvents?: unknown;
  [key: string | symbol]: unknown;
}

export function instrumentLangGraph<T extends CompiledGraphLike>(
  graph: T,
  tracelyxClient: TracelyxClient,
): T {
  const graphAsAny = graph as any;
  if (graphAsAny[INSTRUMENTED]) return graph;

  if (typeof graphAsAny.stream === 'function' && graphAsAny.streamEvents === undefined) {
    console.warn(
      '[Tracelyx] LangGraph: streamEvents not found. Per-node spans and full streaming ' +
        'support require @langchain/langgraph >= 0.2.0.',
    );
  }

  // Patch stream() to create one child span per node update chunk.
  // Reads getActiveContext() at iteration time so it picks up whichever span
  // is active in AsyncLocalStorage — including the invoke span set below.
  if (typeof graphAsAny.stream === 'function') {
    const originalStream = graphAsAny.stream.bind(graphAsAny);

    graphAsAny.stream = async function* (
      input: unknown,
      config?: LangGraphConfig,
    ): AsyncGenerator<unknown> {
      const ctx = getActiveContext();
      const streamTraceId = ctx?.traceId ?? randomUUID();
      const streamParentSpanId = ctx?.spanId ?? null;
      let prevTime = Date.now();

      for await (const chunk of originalStream(input, config)) {
        const now = Date.now();

        if (chunk !== null && typeof chunk === 'object') {
          for (const [nodeName] of Object.entries(chunk as Record<string, unknown>)) {
            const nodeSpan: SpanPayload = {
              id: randomUUID(),
              traceId: streamTraceId,
              parentSpanId: streamParentSpanId,
              name: `langgraph.node.${nodeName}`,
              kind: 'agent_step',
              startTime: prevTime,
              endTime: now,
              durationMs: now - prevTime,
              status: 'ok',
              attributes: {
                'langgraph.node': nodeName,
                'langgraph.node_name': nodeName,
                ...(config?.configurable?.thread_id !== undefined && {
                  'langgraph.thread_id': config.configurable.thread_id,
                }),
              },
              tenantId: getActiveContext()?.tenantId,
            };
            tracelyxClient.recordSpan(nodeSpan);
          }
        }

        yield chunk;
        prevTime = now;
      }
    };
  }

  const originalInvoke = graphAsAny.invoke.bind(graphAsAny);

  graphAsAny.invoke = async function (input: unknown, config?: LangGraphConfig): Promise<unknown> {
    const ctx = getActiveContext();
    const spanId = randomUUID();
    const traceId = ctx?.traceId ?? randomUUID();
    const parentSpanId = ctx?.spanId ?? null;
    const startTime = Date.now();

    const attributes: Record<string, unknown> = {
      'langgraph.thread_id': config?.configurable?.thread_id,
      'langgraph.checkpoint_id': config?.configurable?.checkpoint_id,
    };

    let status: 'ok' | 'error' = 'ok';

    try {
      return await runWithContext({ spanId, traceId }, () => originalInvoke(input, config));
    } catch (error) {
      status = 'error';
      attributes['error.type'] = classifyError(error);
      if (error instanceof Error) {
        attributes['error.message'] = error.message;
        attributes['error.stack'] = error.stack;
      }
      throw error;
    } finally {
      const endTime = Date.now();
      const span: SpanPayload = {
        id: spanId,
        traceId,
        parentSpanId,
        name: 'langgraph.invoke',
        kind: 'agent_step',
        startTime,
        endTime,
        durationMs: endTime - startTime,
        status,
        attributes,
        tenantId: ctx?.tenantId,
      };
      tracelyxClient.recordSpan(span);
    }
  };

  graphAsAny[INSTRUMENTED] = true;
  return graph;
}
