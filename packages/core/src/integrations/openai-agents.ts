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
  run(...args: unknown[]): Promise<unknown>;
  [key: string | symbol]: unknown;
}

function wrapTools(tools: ToolLike[], tracelyxClient: TracelyxClient, handoffTargets: Set<string>): void {
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
        }
        throw error;
      } finally {
        const endTime = Date.now();
        if (toolName.startsWith('transfer_to_')) {
          handoffTargets.add(toolName.slice('transfer_to_'.length));
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

export function instrumentOpenAIAgents<T extends AgentLike>(
  agent: T,
  tracelyxClient: TracelyxClient,
): T {
  const agentAsAny = agent as any;
  if (agentAsAny[INSTRUMENTED]) return agent;

  const originalRun = agentAsAny.run.bind(agentAsAny);
  const agentName = agentAsAny.name ?? 'unknown';
  const handoffTargets = new Set<string>();

  if (Array.isArray(agentAsAny.tools)) {
    wrapTools(agentAsAny.tools as ToolLike[], tracelyxClient, handoffTargets);
  }

  agentAsAny.run = async function (...args: unknown[]): Promise<unknown> {
    const ctx = getActiveContext();
    const spanId = randomUUID();
    const traceId = ctx?.traceId ?? randomUUID();
    const parentSpanId = ctx?.spanId ?? null;
    const startTime = Date.now();

    const attributes: Record<string, unknown> = {
      'agent.name': agentName,
      ...(agentAsAny.model !== undefined && { 'openai.model': agentAsAny.model }),
    };

    let status: 'ok' | 'error' = 'ok';

    try {
      return await runWithContext({ spanId, traceId, tenantId: ctx?.tenantId }, () => originalRun(...args));
    } catch (error) {
      status = 'error';
      attributes['error.type'] = classifyError(error);
      if (error instanceof Error) {
        attributes['error.message'] = error.message;
        attributes['error.stack'] = error.stack;
      }
      throw error;
    } finally {
      if (handoffTargets.size > 0) {
        attributes['handoff.target_agent'] = [...handoffTargets].join(',');
        handoffTargets.clear();
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

  agentAsAny[INSTRUMENTED] = true;
  return agent;
}
