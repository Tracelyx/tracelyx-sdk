import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instrumentOpenAIAgents } from '../../src/integrations/openai-agents.js';
import { TracelyxClient } from '../../src/client.js';
import type { TracePayload } from '../../src/types.js';

// The real @openai/agents SDK executes an agent via Runner.run(agent, input) or the
// free run(agent, input) function; tools expose .invoke(runContext, input). These tests
// mirror that contract with a Runner-mock + tool.invoke, not the Python-SDK shape.
describe('instrumentOpenAIAgents', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: TracelyxClient;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response('{"accepted":1}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    client = new TracelyxClient({ apiKey: 'tl_test', projectId: 'proj_1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wraps runner.run() and creates an agent_step span with model', async () => {
    const agent = { name: 'SupportAgent', model: 'gpt-4o', tools: [] as unknown[] };
    const runner = { run: vi.fn().mockResolvedValue({ finalOutput: 'done' }) };
    instrumentOpenAIAgents(runner, client);

    await runner.run(agent, 'User question');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans.find((s) => s.kind === 'agent_step')!;
    expect(span.name).toBe('agent.SupportAgent');
    expect(span.attributes['agent.name']).toBe('SupportAgent');
    expect(span.attributes['openai.model']).toBe('gpt-4o');
    expect(span.status).toBe('ok');
  });

  it('aggregates token usage from RunResult.runContext.usage onto the agent_step span', async () => {
    const agent = { name: 'A', model: 'gpt-4o' };
    const runner = { run: vi.fn().mockResolvedValue({ runContext: { usage: { inputTokens: 12, outputTokens: 3 } } }) };
    instrumentOpenAIAgents(runner, client);
    await runner.run(agent, 'x');
    await client.flush();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans.find((s) => s.kind === 'agent_step')!;
    expect(span.attributes['llm.prompt_tokens']).toBe(12);
    expect(span.attributes['llm.completion_tokens']).toBe(3);
    // Top-level SpanPayload fields the OTLP exporter reads for gen_ai.usage.* / model.
    expect(span.promptTokens).toBe(12);
    expect(span.completionTokens).toBe(3);
    expect(span.llmModel).toBe('gpt-4o');
  });

  it('creates tool_call child spans via tool.invoke, nested under the run span', async () => {
    const tool = { name: 'search_web', invoke: vi.fn().mockResolvedValue('result') };
    const agent = { name: 'SupportAgent', tools: [tool] };
    const runner = {
      run: vi.fn().mockImplementation(async (a: any) => a.tools[0].invoke({}, JSON.stringify({ q: 'x' }))),
    };
    instrumentOpenAIAgents(runner, client);

    await runner.run(agent, 'q');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const agentSpan = body.spans.find((s) => s.kind === 'agent_step')!;
    const toolSpan = body.spans.find((s) => s.kind === 'tool_call')!;
    expect(toolSpan.attributes['tool.name']).toBe('search_web');
    expect(toolSpan.attributes['tool.arguments']).toBe('{"q":"x"}');
    expect(toolSpan.parentSpanId).toBe(agentSpan.id);
    expect(toolSpan.traceId).toBe(agentSpan.traceId);
  });

  it('records error on the tool span when tool.invoke throws', async () => {
    const tool = { name: 'risky_tool', invoke: vi.fn().mockRejectedValue(new Error('tool exploded')) };
    const agent = { name: 'ErrorAgent', tools: [tool] };
    const runner = {
      run: vi.fn().mockImplementation(async (a: any) => {
        try {
          await a.tools[0].invoke({}, '{}');
        } catch {
          /* agent handles error */
        }
        return {};
      }),
    };
    instrumentOpenAIAgents(runner, client);

    await runner.run(agent, 'task');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolSpan = body.spans.find((s) => s.kind === 'tool_call')!;
    expect(toolSpan.status).toBe('error');
    expect(toolSpan.attributes['error.message']).toBe('tool exploded');
    expect(toolSpan.attributes['error.name']).toBe('Error');
  });

  it('sets handoff.target_agent on transfer_to_ tool span and aggregates on run span', async () => {
    const transfer = { name: 'transfer_to_billing', invoke: vi.fn().mockResolvedValue(null) };
    const agent = { name: 'triage', tools: [transfer] };
    const runner = { run: vi.fn().mockImplementation(async (a: any) => a.tools[0].invoke({}, '{}')) };
    instrumentOpenAIAgents(runner, client);

    await runner.run(agent, 'billing');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolSpan = body.spans.find((s) => s.kind === 'tool_call')!;
    const agentSpan = body.spans.find((s) => s.kind === 'agent_step')!;
    expect(toolSpan.attributes['handoff.target_agent']).toBe('billing');
    expect(agentSpan.attributes['handoff.target_agent']).toBe('billing');
  });

  it('records error.type when runner.run rejects', async () => {
    const agent = { name: 'helper' };
    const runner = { run: vi.fn().mockRejectedValue(new Error('rate limit exceeded')) };
    instrumentOpenAIAgents(runner, client);

    await expect(runner.run(agent, 'x')).rejects.toThrow('rate limit');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans.find((s) => s.kind === 'agent_step')!;
    expect(span.status).toBe('error');
    expect(span.attributes['error.type']).toBe('rate_limit');
    expect(span.attributes['error.message']).toBe('rate limit exceeded');
    expect(span.attributes['error.name']).toBe('Error');
  });

  it('runner instrumentation is idempotent', async () => {
    const agent = { name: 'A' };
    const runner = { run: vi.fn().mockResolvedValue({}) };
    instrumentOpenAIAgents(runner, client);
    instrumentOpenAIAgents(runner, client);
    await runner.run(agent, 'x');
    await client.flush();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans.filter((s) => s.kind === 'agent_step')).toHaveLength(1);
  });

  it('propagates tenantId and openai.model absence correctly', async () => {
    const agent = { name: 'NoModelAgent' }; // brak model
    const runner = { run: vi.fn().mockResolvedValue({}) };
    instrumentOpenAIAgents(runner, client);

    const trace = client.startTrace({ name: 'run', tenantId: 'tenant-xyz' });
    await trace.trace('step', async () => {
      await runner.run(agent, 'go');
    });
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans.find((s) => s.kind === 'agent_step')!;
    expect(span.tenantId).toBe('tenant-xyz');
    expect(span.attributes['openai.model']).toBeUndefined();
  });

  it('propagates tenantId to tool_call spans via runWithContext', async () => {
    const tool = { name: 'do_thing', invoke: vi.fn().mockResolvedValue('ok') };
    const agent = { name: 'ToolAgent', tools: [tool] };
    const runner = { run: vi.fn().mockImplementation(async (a: any) => a.tools[0].invoke({}, '{}')) };
    instrumentOpenAIAgents(runner, client);

    const trace = client.startTrace({ name: 'run', tenantId: 'tenant-abc' });
    await trace.trace('step', async () => {
      await runner.run(agent, 'go');
    });
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolSpan = body.spans.find((s) => s.kind === 'tool_call')!;
    expect(toolSpan.tenantId).toBe('tenant-abc');
  });

  it('links agent_step to the parent trace span via AsyncLocalStorage', async () => {
    const agent = { name: 'InnerAgent' };
    const runner = { run: vi.fn().mockResolvedValue({}) };
    instrumentOpenAIAgents(runner, client);

    const trace = client.startTrace({ name: 'pipeline' });
    await trace.trace('orchestrate', async () => {
      await runner.run(agent, 'task');
    });
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const agentSpan = body.spans.find((s) => s.name === 'agent.InnerAgent')!;
    const parentSpan = body.spans.find((s) => s.name === 'orchestrate')!;
    expect(agentSpan.parentSpanId).toBe(parentSpan.id);
    expect(agentSpan.traceId).toBe(parentSpan.traceId);
  });

  it('instruments an exported run() function passed directly', async () => {
    const agent = { name: 'assistant', model: 'gpt-4o' };
    const rawRun = vi.fn().mockResolvedValue({ finalOutput: 'ok' });
    const run = instrumentOpenAIAgents(rawRun, client);

    await run(agent, 'input');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans.find((s) => s.kind === 'agent_step')!;
    expect(span.name).toBe('agent.assistant');
    expect(rawRun).toHaveBeenCalledWith(agent, 'input');
  });

  it('auto-instruments handoff target agents so their tools emit tool_call spans', async () => {
    const refund = { name: 'refund', invoke: vi.fn().mockResolvedValue('ok') };
    const billing = { name: 'billing', tools: [refund] };
    const triage = { name: 'triage', handoffs: [billing], tools: [] as unknown[] };
    const runner = { run: vi.fn().mockResolvedValue({}) };
    instrumentOpenAIAgents(runner, client);

    await runner.run(triage, 'help');
    // instrumentHandoffTargets(triage.handoffs) must have wrapped billing's tools.
    await billing.tools[0].invoke({}, '{}');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolSpan = body.spans.find(
      (s) => s.kind === 'tool_call' && s.attributes['tool.name'] === 'refund',
    );
    // A recorded tool_call span for billing's tool proves the handoff target was
    // auto-instrumented (wrapTools replaced refund.invoke, so the span is the evidence).
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes['tool.name']).toBe('refund');
  });

  it('supports handoff objects wrapping the agent ({ agent } shape)', async () => {
    const refund = { name: 'refund', invoke: vi.fn().mockResolvedValue('ok') };
    const target = { name: 'refunds', tools: [refund] };
    const source = {
      name: 'support',
      handoffs: [{ agent: target, toolName: 'transfer_to_refunds' }],
      tools: [] as unknown[],
    };
    const runner = { run: vi.fn().mockResolvedValue({}) };
    instrumentOpenAIAgents(runner, client);

    await runner.run(source, 'x');
    await target.tools[0].invoke({}, '{}');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolSpan = body.spans.find(
      (s) => s.kind === 'tool_call' && s.attributes['tool.name'] === 'refund',
    );
    expect(toolSpan).toBeDefined();
  });

  it('does not infinitely recurse on mutual handoff cycles (A <-> B)', async () => {
    const toolA = { name: 'ta', invoke: vi.fn().mockResolvedValue('ok') };
    const toolB = { name: 'tb', invoke: vi.fn().mockResolvedValue('ok') };
    const agentA: any = { name: 'a', tools: [toolA], handoffs: [] as unknown[] };
    const agentB: any = { name: 'b', tools: [toolB], handoffs: [agentA] };
    agentA.handoffs.push(agentB);
    const runner = { run: vi.fn().mockResolvedValue({}) };
    instrumentOpenAIAgents(runner, client);

    // Passing agentA through the run must instrument A + its handoff targets without hanging.
    await expect(runner.run(agentA, 'x')).resolves.toBeDefined();
    await toolA.invoke({}, '{}');
    await toolB.invoke({}, '{}');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolNames = body.spans
      .filter((s) => s.kind === 'tool_call')
      .map((s) => s.attributes['tool.name'])
      .sort();
    expect(toolNames).toEqual(['ta', 'tb']);
  });

  it('keeps handoff.target_agent per-run under concurrent runs of the same agent instance', async () => {
    // Run A hands off to billing then parks; run B hands off to refunds and finishes
    // while A is still in flight. Each run's agent_step must carry ONLY its own target.
    let releaseA: () => void = () => {};
    const aHolding = new Promise<void>((r) => {
      releaseA = r;
    });
    const agent: any = {
      name: 'triage',
      tools: [
        { name: 'transfer_to_billing', invoke: vi.fn().mockResolvedValue(null) },
        { name: 'transfer_to_refunds', invoke: vi.fn().mockResolvedValue(null) },
      ],
    };
    const runner = {
      run: vi.fn().mockImplementation(async (a: any, which: string) => {
        if (which === 'A') {
          await a.tools[0].invoke({}, '{}'); // billing
          await aHolding;
          return 'A';
        }
        await a.tools[1].invoke({}, '{}'); // refunds
        return 'B';
      }),
    };
    instrumentOpenAIAgents(runner, client);

    const pA = runner.run(agent, 'A'); // records billing, then parks at the barrier
    await new Promise((r) => setTimeout(r, 0)); // let A reach the barrier
    await runner.run(agent, 'B'); // records refunds and completes while A holds
    releaseA();
    await pA;
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const targets = body.spans
      .filter((s) => s.kind === 'agent_step')
      .map((s) => s.attributes['handoff.target_agent'])
      .sort();
    expect(targets).toEqual(['billing', 'refunds']);
  });
});
