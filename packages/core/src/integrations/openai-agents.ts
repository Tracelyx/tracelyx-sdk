import { randomUUID } from 'crypto';
import { getActiveContext, runWithContext } from '../tracer.js';
import { classifyError } from '../errors.js';
import type { TracelyxClient } from '../client.js';
import type { SpanPayload } from '../types.js';

const INSTRUMENTED = Symbol('tracelyx.instrumented');
const TOOL_INSTRUMENTED = Symbol('tracelyx.tool.instrumented');

interface ToolLike {
  name: string;
  on_invoke_tool?(...args: unknown[]): Promise<unknown>;
  [key: string | symbol]: unknown;
}

interface AgentLike {
  name?: string;
  model?: string;
  tools?: ToolLike[];
  handoffs?: unknown[];
  run(...args: unknown[]): Promise<unknown>;
  [key: string | symbol]: unknown;
}

function wrapTools(tools: ToolLike[], tracelyxClient: TracelyxClient): void {
  for (const tool of tools) {
    if (tool[TOOL_INSTRUMENTED]) continue;
    if (typeof tool.on_invoke_tool !== 'function') continue;

    const originalToolFn = tool.on_invoke_tool.bind(tool);
    const toolName = tool.name;

    tool.on_invoke_tool = async function (...args: unknown[]): Promise<unknown> {
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

interface RunnerLike {
  run(agent: unknown, ...args: unknown[]): Promise<unknown>;
  [key: string | symbol]: unknown;
}

function isRunnerLike(value: AgentLike | RunnerLike): value is RunnerLike {
  return (
    typeof value.run === 'function' &&
    (value as AgentLike).name === undefined &&
    (value as AgentLike).tools === undefined &&
    (value as AgentLike).handoffs === undefined
  );
}

function instrumentHandoffTargets(handoffs: unknown[], tracelyxClient: TracelyxClient): void {
  for (const handoff of handoffs) {
    const target =
      handoff !== null && typeof handoff === 'object' && 'agent' in (handoff as object)
        ? (handoff as { agent: unknown }).agent
        : handoff;
    if (
      target !== null &&
      typeof target === 'object' &&
      typeof (target as AgentLike).run === 'function'
    ) {
      instrumentAgent(target as AgentLike, tracelyxClient);
    }
  }
}

export function instrumentOpenAIAgents<T extends AgentLike | RunnerLike>(
  agentOrRunner: T,
  tracelyxClient: TracelyxClient,
): T {
  if (isRunnerLike(agentOrRunner)) {
    return instrumentRunner(agentOrRunner, tracelyxClient) as T;
  }
  return instrumentAgent(agentOrRunner as AgentLike, tracelyxClient) as T;
}

function instrumentAgent<T extends AgentLike>(
  agent: T,
  tracelyxClient: TracelyxClient,
): T {
  const agentAsAny = agent as any;
  if (agentAsAny[INSTRUMENTED]) return agent;
  // Mark before wrapping/recursion so handoff cycles (A <-> B) terminate.
  agentAsAny[INSTRUMENTED] = true;

  const originalRun = agentAsAny.run.bind(agentAsAny);
  const agentName = agentAsAny.name ?? 'unknown';

  if (Array.isArray(agentAsAny.tools)) {
    wrapTools(agentAsAny.tools as ToolLike[], tracelyxClient);
  }

  if (Array.isArray(agentAsAny.handoffs)) {
    instrumentHandoffTargets(agentAsAny.handoffs, tracelyxClient);
  }

  agentAsAny.run = async function (...args: unknown[]): Promise<unknown> {
    const ctx = getActiveContext();
    const spanId = randomUUID();
    const traceId = ctx?.traceId ?? randomUUID();
    const parentSpanId = ctx?.spanId ?? null;
    const startTime = Date.now();
    // Fresh per-run collector — tools attribute their handoff into this via context.
    const handoffTargets = new Set<string>();

    const attributes: Record<string, unknown> = {
      'agent.name': agentName,
      ...(agentAsAny.model !== undefined && { 'openai.model': agentAsAny.model }),
    };

    let status: 'ok' | 'error' = 'ok';

    try {
      return await runWithContext(
        { spanId, traceId, tenantId: ctx?.tenantId, handoffTargets },
        () => originalRun(...args),
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
      if (handoffTargets.size > 0) {
        attributes['handoff.target_agent'] = [...handoffTargets].join(',');
      }
      const endTime = Date.now();
      const span: SpanPayload = {
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
      };
      tracelyxClient.recordSpan(span);
    }
  };

  return agent;
}

function instrumentRunner<T extends RunnerLike>(runner: T, tracelyxClient: TracelyxClient): T {
  const runnerAsAny = runner as any;
  if (runnerAsAny[INSTRUMENTED]) return runner;
  // Mark before wrapping so a runner instrumented twice does not double-wrap.
  runnerAsAny[INSTRUMENTED] = true;

  const originalRun = runnerAsAny.run.bind(runnerAsAny);

  runnerAsAny.run = async function (agentArg: unknown, ...args: unknown[]): Promise<unknown> {
    const agent = (agentArg ?? {}) as AgentLike;
    // Instrument the agent's tools/handoffs, but NOT agent.run (the runner never calls it).
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
    const handoffTargets = new Set<string>();

    const attributes: Record<string, unknown> = {
      'agent.name': agentName,
      ...(agent.model !== undefined && { 'openai.model': agent.model }),
    };

    let status: 'ok' | 'error' = 'ok';

    try {
      return await runWithContext(
        { spanId, traceId, tenantId: ctx?.tenantId, handoffTargets },
        () => originalRun(agentArg, ...args),
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
      });
    }
  };

  return runner;
}
