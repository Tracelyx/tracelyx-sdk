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

interface StreamEventLike {
  event?: string;
  name?: string;
  run_id?: string;
  parent_ids?: string[];
  metadata?: { langgraph_node?: string; [key: string]: unknown };
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

  if (typeof graphAsAny.stream === 'function' && typeof graphAsAny.streamEvents !== 'function') {
    console.warn(
      '[Tracelyx] LangGraph: streamEvents not found. Per-node spans and full streaming ' +
        'support require @langchain/langgraph >= 0.2.0.',
    );
  }

  // Patch stream() to create one child span per node update chunk.
  // Reads getActiveContext() at iteration time so it picks up whichever span
  // is active in AsyncLocalStorage — including the invoke span set below.
  //
  // Per-node spans are only derivable from streamMode 'updates', where each
  // chunk is shaped `{ nodeName: partialState }`. Under LangGraph's default
  // 'values' mode a chunk is the full state keyed by channels, so treating
  // every key as a node would emit bogus per-channel spans — we skip emission
  // (and pass chunks through untouched) unless 'updates' is explicitly set.
  // For reliable per-node timing regardless of mode, use streamEvents() below.
  if (typeof graphAsAny.stream === 'function') {
    const originalStream = graphAsAny.stream.bind(graphAsAny);

    graphAsAny.stream = async function* (
      input: unknown,
      config?: LangGraphConfig,
    ): AsyncGenerator<unknown> {
      const emitNodeSpans = config?.streamMode === 'updates';
      const ctx = getActiveContext();
      const streamTraceId = ctx?.traceId ?? randomUUID();
      const streamParentSpanId = ctx?.spanId ?? null;
      let prevTime = Date.now();

      for await (const chunk of originalStream(input, config)) {
        const now = Date.now();

        if (emitNodeSpans && chunk !== null && typeof chunk === 'object') {
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
                ...(config?.configurable?.checkpoint_id !== undefined && {
                  'langgraph.checkpoint_id': config.configurable.checkpoint_id,
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

  // Patch streamEvents() to create node spans with accurate start/end times paired by run_id.
  if (typeof graphAsAny.streamEvents === 'function') {
    const originalStreamEvents = graphAsAny.streamEvents.bind(graphAsAny);

    graphAsAny.streamEvents = async function* (
      input: unknown,
      options?: LangGraphConfig,
      ...rest: unknown[]
    ): AsyncGenerator<unknown> {
      const ctx = getActiveContext();
      const traceId = ctx?.traceId ?? randomUUID();
      const parentSpanId = ctx?.spanId ?? null;
      const openNodes = new Map<string, { name: string; startTime: number; spanId: string }>();
      const runIdToSpanId = new Map<string, string>();

      for await (const event of originalStreamEvents(input, options, ...rest)) {
        const e = event as StreamEventLike;
        const nodeName = e.metadata?.langgraph_node;

        if (nodeName !== undefined && e.run_id !== undefined) {
          if (e.event === 'on_chain_start' && e.name === nodeName) {
            // Przydziel spanId na starcie, by potomny węzeł mógł wskazać ten span jako rodzica.
            const nodeSpanId = randomUUID();
            runIdToSpanId.set(e.run_id, nodeSpanId);
            openNodes.set(e.run_id, { name: nodeName, startTime: Date.now(), spanId: nodeSpanId });
          } else if (e.event === 'on_chain_end' && openNodes.has(e.run_id)) {
            const { name, startTime, spanId: nodeSpanId } = openNodes.get(e.run_id)!;
            openNodes.delete(e.run_id);
            const now = Date.now();

            // Rodzic = najbliższy przodek z parent_ids, który jest znanym node spanem; inaczej span invoke.
            let nodeParentSpanId = parentSpanId;
            const ancestors = e.parent_ids ?? [];
            for (let i = ancestors.length - 1; i >= 0; i--) {
              const candidate = runIdToSpanId.get(ancestors[i]);
              if (candidate !== undefined && candidate !== nodeSpanId) {
                nodeParentSpanId = candidate;
                break;
              }
            }

            tracelyxClient.recordSpan({
              id: nodeSpanId,
              traceId,
              parentSpanId: nodeParentSpanId,
              name: `langgraph.node.${name}`,
              kind: 'agent_step',
              startTime,
              endTime: now,
              durationMs: now - startTime,
              status: 'ok',
              attributes: {
                'langgraph.node': name,
                'langgraph.node_name': name,
                ...(options?.configurable?.thread_id !== undefined && {
                  'langgraph.thread_id': options.configurable.thread_id,
                }),
                ...(options?.configurable?.checkpoint_id !== undefined && {
                  'langgraph.checkpoint_id': options.configurable.checkpoint_id,
                }),
              },
              tenantId: ctx?.tenantId,
            });
          }
        }

        yield event;
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
      ...(config?.configurable?.thread_id !== undefined && {
        'langgraph.thread_id': config.configurable.thread_id,
      }),
      ...(config?.configurable?.checkpoint_id !== undefined && {
        'langgraph.checkpoint_id': config.configurable.checkpoint_id,
      }),
    };

    let status: 'ok' | 'error' = 'ok';

    try {
      return await runWithContext({ spanId, traceId, tenantId: ctx?.tenantId }, () =>
        originalInvoke(input, config),
      );
    } catch (error) {
      status = 'error';
      attributes['error.type'] = classifyError(error);
      if (error instanceof Error) {
        attributes['error.message'] = error.message;
        attributes['error.stack'] = error.stack;
        attributes['error.name'] = error.name;
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
