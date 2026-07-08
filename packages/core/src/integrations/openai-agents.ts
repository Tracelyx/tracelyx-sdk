import { randomUUID } from 'crypto';
import { getActiveContext, runWithContext } from '../tracer.js';
import { classifyError } from '../errors.js';
import type { TracelyxClient } from '../client.js';
import type { SpanPayload } from '../types.js';

const INSTRUMENTED = Symbol('tracelyx.instrumented');
const TOOL_INSTRUMENTED = Symbol('tracelyx.tool.instrumented');

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
  model?: string;
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

function instrumentHandoffTargets(handoffs: unknown[], tracelyxClient: TracelyxClient): void {
  for (const handoff of handoffs) {
    const target =
      handoff !== null && typeof handoff === 'object' && 'agent' in (handoff as object)
        ? (handoff as { agent: unknown }).agent
        : handoff;
    // Real Agents expose no `.run`, so gate only on "is an object". instrumentAgent is a
    // no-op for objects without tools/handoffs, and its INSTRUMENTED guard breaks cycles.
    if (target !== null && typeof target === 'object') {
      instrumentAgent(target as AgentLike, tracelyxClient);
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
  const startTime = Date.now();
  const agentName = agent.name ?? 'unknown';
  // Fresh per-run collector — tools attribute their handoff into this via context.
  const handoffTargets = new Set<string>();
  const attributes: Record<string, unknown> = {
    'agent.name': agentName,
    ...(agent.model !== undefined && { 'openai.model': agent.model }),
  };
  let status: 'ok' | 'error' = 'ok';
  let result: unknown;
  // Hoisted so the finally block can also set the top-level SpanPayload fields that the
  // OTLP exporter reads for gen_ai.usage.* (mirrors the Anthropic integration).
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  try {
    result = await runWithContext(
      { spanId, traceId, tenantId: ctx?.tenantId, handoffTargets },
      () => originalRun(agentArg, ...args),
    );
    const usage = extractUsage(result);
    promptTokens = usage.promptTokens;
    completionTokens = usage.completionTokens;
    if (usage.promptTokens !== undefined) attributes['llm.prompt_tokens'] = usage.promptTokens;
    if (usage.completionTokens !== undefined) {
      attributes['llm.completion_tokens'] = usage.completionTokens;
    }
    return result;
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
    if (handoffTargets.size > 0) {
      attributes['handoff.target_agent'] = [...handoffTargets].join(',');
    }
    const endTime = Date.now();
    tracelyxClient.recordSpan({
      id: spanId,
      traceId,
      parentSpanId,
      name: `agent.${agentName}`,
      kind: 'agent_step',
      startTime,
      endTime,
      durationMs: endTime - startTime,
      status,
      attributes,
      tenantId: ctx?.tenantId,
      // Top-level fields the OTLP exporter maps to gen_ai.request.model / gen_ai.usage.*.
      ...(agent.model !== undefined && { llmModel: agent.model }),
      ...(promptTokens !== undefined && { promptTokens }),
      ...(completionTokens !== undefined && { completionTokens }),
    });
  }
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
  return function (agentArg: unknown, ...args: unknown[]): Promise<unknown> {
    return createRunSpan(originalRun, agentArg, args, tracelyxClient);
  };
}
