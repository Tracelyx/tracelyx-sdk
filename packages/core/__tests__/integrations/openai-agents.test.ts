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

  it('records a handoff span and aggregates handoff.target_agent from a Handoff in agent.handoffs', async () => {
    // Real handoffs live in agent.handoffs as Handoff instances (onInvokeHandoff), NOT in
    // agent.tools — so the transfer_to_ tool branch never fires for them. The runner invokes
    // the selected Handoff's onInvokeHandoff at handoff time; that is what we must capture.
    const billing = { name: 'billing', tools: [] as unknown[] };
    const handoffObj = {
      agent: billing,
      agentName: 'billing',
      toolName: 'transfer_to_billing',
      onInvokeHandoff: vi.fn().mockResolvedValue(billing),
    };
    const source = { name: 'triage', handoffs: [handoffObj], tools: [] as unknown[] };
    const runner = {
      run: vi.fn().mockImplementation(async (a: any) => a.handoffs[0].onInvokeHandoff({}, '{}')),
    };
    instrumentOpenAIAgents(runner, client);

    const returned = await runner.run(source, 'I need billing help');
    await client.flush();

    // The original return value (the target agent) must be preserved exactly.
    expect(returned).toBe(billing);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const handoffSpan = body.spans.find((s) => s.name === 'handoff.billing');
    expect(handoffSpan).toBeDefined();
    expect(handoffSpan!.kind).toBe('agent_step');
    expect(handoffSpan!.attributes['handoff.target_agent']).toBe('billing');
    // Aggregated onto the run's agent_step span too.
    const agentSpan = body.spans.find((s) => s.name === 'agent.triage')!;
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

  it('omits llmModel and openai.model when agent.model is a non-string Model object', async () => {
    // Agent.model is typed `string | Model`; at runtime the runner may carry a Model object.
    // Copying it verbatim would emit an invalid non-string gen_ai.request.model / openai.model.
    const modelObject = { name: 'gpt-4o', getResponse: () => undefined };
    const agent = { name: 'ModelObjAgent', model: modelObject };
    const runner = { run: vi.fn().mockResolvedValue({}) };
    instrumentOpenAIAgents(runner, client);

    await runner.run(agent, 'x');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans.find((s) => s.kind === 'agent_step')!;
    expect(span.llmModel).toBeUndefined();
    expect(span.attributes['openai.model']).toBeUndefined();
  });

  it('defers the agent_step span for streamed runs until completed resolves (usage read after stream drains)', async () => {
    // A real streamed run resolves with a StreamedRunResult BEFORE the model output is
    // consumed: runContext.usage is still empty at setup and only aggregates as the stream
    // drains. `completed` resolves once draining finishes. This fake mirrors that: usage is
    // empty at setup and populated exactly when `completed` resolves.
    const agent = { name: 'StreamAgent', model: 'gpt-4o' };
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((r) => {
      resolveCompleted = r;
    });
    const streamedResult = {
      runContext: { usage },
      async *[Symbol.asyncIterator]() {
        /* nothing to yield in the mock */
      },
      completed,
    };
    const runner = { run: vi.fn().mockResolvedValue(streamedResult) };
    instrumentOpenAIAgents(runner, client);

    const returned = await runner.run(agent, 'x', { stream: true });
    // The wrapper must hand back the exact StreamedRunResult so the caller can consume it.
    expect(returned).toBe(streamedResult);

    // At setup usage is still empty (the buggy code records HERE with no tokens). Now simulate
    // the stream draining: usage aggregates, then `completed` resolves — the fix records only now.
    usage.inputTokens = 7;
    usage.outputTokens = 2;
    resolveCompleted();

    // Drain microtasks so the `.completed` callback (and thus recordFinal) runs BEFORE flush.
    await new Promise((r) => setTimeout(r, 0));
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans.find((s) => s.kind === 'agent_step')!;
    // Usage read AFTER completed — not the empty setup-time read.
    expect(span.promptTokens).toBe(7);
    expect(span.completionTokens).toBe(2);
    expect(span.attributes['llm.prompt_tokens']).toBe(7);
    expect(span.attributes['llm.completion_tokens']).toBe(2);
    expect(span.status).toBe('ok');
  });

  it('records exactly one agent_step span on a non-stream run (control for the deferred path)', async () => {
    const agent = { name: 'PlainAgent', model: 'gpt-4o' };
    const runner = {
      run: vi.fn().mockResolvedValue({ runContext: { usage: { inputTokens: 4, outputTokens: 1 } } }),
    };
    instrumentOpenAIAgents(runner, client);

    await runner.run(agent, 'x');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const agentSpans = body.spans.filter((s) => s.kind === 'agent_step');
    expect(agentSpans).toHaveLength(1);
    expect(agentSpans[0].promptTokens).toBe(4);
    expect(agentSpans[0].completionTokens).toBe(1);
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
