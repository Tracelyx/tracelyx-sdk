import { randomUUID } from 'crypto';
import { getActiveContext, runWithContext } from '../tracer.js';
import { classifyError } from '../errors.js';
import type { TracelyxClient } from '../client.js';
import type { SpanPayload } from '../types.js';

const INSTRUMENTED = Symbol('tracelyx.instrumented');
const TOOL_INSTRUMENTED = Symbol('tracelyx.tool.instrumented');
const HANDOFF_INSTRUMENTED = Symbol('tracelyx.handoff.instrumented');

interface ToolLike {
  name: string;
  invoke?(...args: unknown[]): Promise<unknown>;
  [key: string | symbol]: unknown;
}

// A real @openai/agents Agent has NO `.run` method — execution goes through
// Runner.run(agent, input) / the free run(agent, input) function. So an Agent is only
// a carrier of tools + handoffs to instrument; the agent_step span is emitted by the runner.
interface AgentLike {
  name?: string;
  // Typed `string | Model` by the SDK; a Model object at runtime must NOT be copied verbatim
  // into span fields (it would emit a non-string gen_ai.request.model / openai.model).
  model?: unknown;
  tools?: ToolLike[];
  handoffs?: unknown[];
  [key: string | symbol]: unknown;
}

interface RunnerLike {
  run(agent: unknown, ...args: unknown[]): Promise<unknown>;
  [key: string | symbol]: unknown;
}

function wrapTools(tools: ToolLike[], tracelyxClient: TracelyxClient): void {
  for (const tool of tools) {
    if (tool[TOOL_INSTRUMENTED]) continue;
    if (typeof tool.invoke !== 'function') continue;

    const originalToolFn = tool.invoke.bind(tool);
    const toolName = tool.name;

    tool.invoke = async function (...args: unknown[]): Promise<unknown> {
      const ctx = getActiveContext();
      const toolSpanId = randomUUID();
      const startTime = Date.now();
      let status: 'ok' | 'error' = 'ok';
      const attributes: Record<string, unknown> = {
        'tool.name': toolName,
        ...(args[1] !== undefined && { 'tool.arguments': String(args[1]) }),
      };

      try {
        return await originalToolFn(...args);
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
        if (toolName.startsWith('transfer_to_')) {
          const target = toolName.slice('transfer_to_'.length);
          // Attribute to the currently-running agent/runner span (per-run Set),
          // not a Set shared across concurrent runs of the same instance.
          getActiveContext()?.handoffTargets?.add(target);
          attributes['handoff.target_agent'] = target;
        }
        const toolSpan: SpanPayload = {
          id: toolSpanId,
          traceId: ctx?.traceId ?? randomUUID(),
          parentSpanId: ctx?.spanId ?? null,
          name: `tool.${toolName}`,
          kind: 'tool_call',
          startTime,
          endTime,
          durationMs: endTime - startTime,
          status,
          attributes,
          tenantId: ctx?.tenantId,
        };
        tracelyxClient.recordSpan(toolSpan);
      }
    };

    tool[TOOL_INSTRUMENTED] = true;
  }
}

function readName(obj: unknown): string | undefined {
  return obj !== null &&
    typeof obj === 'object' &&
    typeof (obj as { name?: unknown }).name === 'string'
    ? (obj as { name: string }).name
    : undefined;
}

interface HandoffLike {
  onInvokeHandoff: (...args: unknown[]) => unknown;
  agent?: unknown;
  agentName?: unknown;
  toolName?: unknown;
  [key: string | symbol]: unknown;
}

// Wrap a real `@openai/agents` `Handoff.onInvokeHandoff`. The runner calls this at handoff
// time (inside Runner.run, so getActiveContext() is the active run context) to resolve the
// next agent. We feed the per-run aggregate Set and emit a dedicated handoff span, then return
// the original result (the target Agent) untouched.
function wrapHandoff(
  handoffEntry: HandoffLike,
  targetName: string,
  tracelyxClient: TracelyxClient,
): void {
  if (handoffEntry[HANDOFF_INSTRUMENTED]) return;
  const originalOnInvoke = handoffEntry.onInvokeHandoff.bind(handoffEntry);

  handoffEntry.onInvokeHandoff = async function (...args: unknown[]): Promise<unknown> {
    const ctx = getActiveContext();
    const spanId = randomUUID();
    const startTime = Date.now();
    let status: 'ok' | 'error' = 'ok';
    const attributes: Record<string, unknown> = { 'handoff.target_agent': targetName };
    // Feed the agent_step aggregate (createRunSpan joins this Set into handoff.target_agent).
    ctx?.handoffTargets?.add(targetName);

    try {
      return await originalOnInvoke(...args);
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
      const handoffSpan: SpanPayload = {
        id: spanId,
        traceId: ctx?.traceId ?? randomUUID(),
        parentSpanId: ctx?.spanId ?? null,
        name: `handoff.${targetName}`,
        kind: 'agent_step',
        startTime,
        endTime,
        durationMs: endTime - startTime,
        status,
        attributes,
        tenantId: ctx?.tenantId,
      };
      tracelyxClient.recordSpan(handoffSpan);
    }
  };

  handoffEntry[HANDOFF_INSTRUMENTED] = true;
}

function instrumentHandoffTargets(handoffs: unknown[], tracelyxClient: TracelyxClient): void {
  for (const entry of handoffs) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as HandoffLike & { name?: unknown };

    // A real Handoff instance carries a callable `onInvokeHandoff` (the runner invokes it at
    // handoff time). Anything else is either a `{ agent }` wrapper or a raw Agent shorthand.
    const isHandoff = typeof e.onInvokeHandoff === 'function';

    let targetAgent: unknown;
    let targetName: string | undefined;
    if (isHandoff) {
      targetAgent = e.agent;
      targetName =
        (typeof e.agentName === 'string' ? e.agentName : undefined) ??
        readName(e.agent) ??
        (typeof e.toolName === 'string' && e.toolName.startsWith('transfer_to_')
          ? e.toolName.slice('transfer_to_'.length)
          : undefined);
    } else if ('agent' in e) {
      targetAgent = e.agent;
      targetName = readName(e.agent);
    } else {
      targetAgent = entry;
      targetName = readName(entry);
    }

    // Recursively instrument the target agent's tools + nested handoffs (existing behavior).
    // Real Agents expose no `.run`, so gate only on "is an object". instrumentAgent is a
    // no-op for objects without tools/handoffs, and its INSTRUMENTED guard breaks cycles.
    if (targetAgent !== null && typeof targetAgent === 'object') {
      instrumentAgent(targetAgent as AgentLike, tracelyxClient);
    }

    // Only a real Handoff has an onInvokeHandoff to wrap. The bare `handoffs: [agent]`
    // shorthand has none — the SDK builds the Handoff internally at run time, which this
    // zero-dep monkey-patch cannot reach, so its fired-handoff cannot be captured here
    // (use @openai/agents addTraceProcessor for full multi-agent topology).
    if (isHandoff && typeof targetName === 'string' && targetName.length > 0) {
      wrapHandoff(e, targetName, tracelyxClient);
    }
  }
}

export function instrumentOpenAIAgents<T>(target: T, tracelyxClient: TracelyxClient): T {
  // 1) Exported run(agent, input) function: return a wrapped function
  //    (call-site: const run = instrumentOpenAIAgents(run, client)).
  if (typeof target === 'function') {
    return wrapRunFunction(
      target as unknown as (...a: unknown[]) => Promise<unknown>,
      tracelyxClient,
    ) as unknown as T;
  }
  if (target !== null && typeof target === 'object') {
    // 2) Runner: object with a run(agent, input) method.
    if (typeof (target as unknown as RunnerLike).run === 'function') {
      return instrumentRunner(target as unknown as RunnerLike, tracelyxClient) as unknown as T;
    }
    // 3) Agent: no `.run` — wrap only tools + handoffs (the agent_step span is emitted
    //    from the Runner/run() path).
    return instrumentAgent(target as AgentLike, tracelyxClient) as unknown as T;
  }
  return target;
}

function instrumentAgent<T extends AgentLike>(agent: T, tracelyxClient: TracelyxClient): T {
  const agentAsAny = agent as any;
  if (agentAsAny[INSTRUMENTED]) return agent;
  // Mark before wrapping/recursion so handoff cycles (A <-> B) terminate.
  agentAsAny[INSTRUMENTED] = true;
  if (Array.isArray(agentAsAny.tools)) {
    wrapTools(agentAsAny.tools as ToolLike[], tracelyxClient);
  }
  if (Array.isArray(agentAsAny.handoffs)) {
    instrumentHandoffTargets(agentAsAny.handoffs, tracelyxClient);
  }
  return agent;
}

function extractUsage(result: unknown): { promptTokens?: number; completionTokens?: number } {
  // Best-effort: the real @openai/agents RunResult exposes aggregate usage at
  // runContext.usage (or state.context.usage), a Usage with inputTokens/outputTokens.
  // Fall back to a top-level `usage` for other shapes. Read safely, no hard coupling.
  const r = result as {
    usage?: { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
    runContext?: { usage?: { inputTokens?: number; outputTokens?: number } };
    state?: { context?: { usage?: { inputTokens?: number; outputTokens?: number } } };
  } | null;
  const u = r?.runContext?.usage ?? r?.state?.context?.usage ?? r?.usage;
  if (!u) return {};
  return {
    promptTokens: u.inputTokens ?? (u as { promptTokens?: number }).promptTokens,
    completionTokens: u.outputTokens ?? (u as { completionTokens?: number }).completionTokens,
  };
}

async function createRunSpan(
  originalRun: (...args: unknown[]) => Promise<unknown>,
  agentArg: unknown,
  args: unknown[],
  tracelyxClient: TracelyxClient,
): Promise<unknown> {
  const agent = (agentArg ?? {}) as AgentLike;
  if (agent !== null && typeof agent === 'object') {
    if (Array.isArray(agent.tools)) wrapTools(agent.tools, tracelyxClient);
    if (Array.isArray(agent.handoffs)) instrumentHandoffTargets(agent.handoffs, tracelyxClient);
  }

  const ctx = getActiveContext();
  const spanId = randomUUID();
  const traceId = ctx?.traceId ?? randomUUID();
  const parentSpanId = ctx?.spanId ?? null;
  const tenantId = ctx?.tenantId;
  const startTime = Date.now();
  const agentName = agent.name ?? 'unknown';
  // Fresh per-run collector — tools attribute their handoff into this via context.
  const handoffTargets = new Set<string>();
  const attributes: Record<string, unknown> = {
    'agent.name': agentName,
    // RF-4: only a string model is a valid attribute value; a Model object is omitted.
    ...(typeof agent.model === 'string' && { 'openai.model': agent.model }),
  };

  // Records the agent_step span exactly once. Called either immediately (non-stream / error)
  // or, for streamed runs, from the `.completed` callback. It uses the CAPTURED span context
  // variables (spanId/traceId/parentSpanId/tenantId), never getActiveContext(), because the
  // deferred streamed invocation runs outside the AsyncLocalStorage context of the run.
  function recordFinal(finalStatus: 'ok' | 'error', resultForUsage: unknown, error?: unknown): void {
    const endTime = Date.now();
    const usage = extractUsage(resultForUsage);
    if (usage.promptTokens !== undefined) attributes['llm.prompt_tokens'] = usage.promptTokens;
    if (usage.completionTokens !== undefined) {
      attributes['llm.completion_tokens'] = usage.completionTokens;
    }
    // Classify errors in one place so the sync catch and the streamed-failure path stay symmetric.
    if (finalStatus === 'error' && error !== undefined) {
      attributes['error.type'] = classifyError(error);
      if (error instanceof Error) {
        attributes['error.message'] = error.message;
        attributes['error.stack'] = error.stack;
        attributes['error.name'] = error.name;
      }
    }
    if (handoffTargets.size > 0) {
      attributes['handoff.target_agent'] = [...handoffTargets].join(',');
    }
    tracelyxClient.recordSpan({
      id: spanId,
      traceId,
      parentSpanId,
      name: `agent.${agentName}`,
      kind: 'agent_step',
      startTime,
      endTime,
      durationMs: endTime - startTime,
      status: finalStatus,
      attributes,
      tenantId,
      // Top-level fields the OTLP exporter maps to gen_ai.request.model / gen_ai.usage.*.
      // RF-4: skip llmModel entirely when the model isn't a string (Model object).
      ...(typeof agent.model === 'string' && { llmModel: agent.model }),
      ...(usage.promptTokens !== undefined && { promptTokens: usage.promptTokens }),
      ...(usage.completionTokens !== undefined && { completionTokens: usage.completionTokens }),
    });
  }

  let result: unknown;
  try {
    result = await runWithContext(
      { spanId, traceId, tenantId, handoffTargets },
      () => originalRun(agentArg, ...args),
    );
  } catch (error) {
    recordFinal('error', undefined, error);
    throw error;
  }

  // RF-3: a streamed run (run(..., { stream: true })) resolves with a StreamedRunResult
  // IMMEDIATELY, before the model output is consumed — usage/timing are only final once its
  // `.completed` promise resolves. Duck-type it (no SDK import → zero runtime deps): a plain
  // RunResult has no `completed` thenable.
  const streamed =
    result !== null &&
    typeof result === 'object' &&
    typeof (result as { completed?: { then?: unknown } }).completed?.then === 'function';

  if (streamed) {
    // Defer recording until the stream drains. Caveat: if the caller never consumes the stream,
    // `completed` never resolves and no span is emitted — this mirrors the SDK, which also only
    // finalizes the run once the stream is drained. The two-argument `.then(onOk, onErr)` form
    // (not `.then().catch()`) guarantees the span is recorded EXACTLY ONCE: onErr fires only for
    // the original rejection, never for an error thrown inside onOk.
    Promise.resolve((result as { completed: Promise<unknown> }).completed).then(
      () => recordFinal('ok', result),
      (err) => recordFinal('error', result, err),
    );
    return result;
  }

  recordFinal('ok', result);
  return result;
}

function instrumentRunner<T extends RunnerLike>(runner: T, tracelyxClient: TracelyxClient): T {
  const runnerAsAny = runner as any;
  if (runnerAsAny[INSTRUMENTED]) return runner;
  // Mark before wrapping so a runner instrumented twice does not double-wrap.
  runnerAsAny[INSTRUMENTED] = true;
  const originalRun = runnerAsAny.run.bind(runnerAsAny);
  runnerAsAny.run = function (agentArg: unknown, ...args: unknown[]): Promise<unknown> {
    return createRunSpan(originalRun, agentArg, args, tracelyxClient);
  };
  return runner;
}

function wrapRunFunction(
  originalRun: (...args: unknown[]) => Promise<unknown>,
  tracelyxClient: TracelyxClient,
): (...args: unknown[]) => Promise<unknown> {
  const originalAsAny = originalRun as unknown as Record<symbol, unknown>;
  if (originalAsAny[INSTRUMENTED]) return originalRun;
  const wrapped = function (agentArg: unknown, ...args: unknown[]): Promise<unknown> {
    return createRunSpan(originalRun, agentArg, args, tracelyxClient);
  };
  (wrapped as unknown as Record<symbol, unknown>)[INSTRUMENTED] = true;
  return wrapped;
}
