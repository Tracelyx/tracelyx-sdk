import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instrumentOpenAIAgents } from '../../src/integrations/openai-agents.js';
import { TracelyxClient } from '../../src/client.js';
import type { TracePayload } from '../../src/types.js';

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

  it('wraps agent.run() and creates an agent_step span', async () => {
    const agent = {
      name: 'SupportAgent',
      model: 'gpt-4o',
      run: vi.fn().mockResolvedValue({ output: 'done' }),
    };

    instrumentOpenAIAgents(agent, client);
    await agent.run('User question', {});

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans[0];

    expect(span.kind).toBe('agent_step');
    expect(span.name).toBe('agent.SupportAgent');
    expect(span.attributes['agent.name']).toBe('SupportAgent');
    expect(span.attributes['openai.model']).toBe('gpt-4o');
    expect(span.status).toBe('ok');
  });

  it('records error status when run() throws', async () => {
    const agent = {
      name: 'FailAgent',
      run: vi.fn().mockRejectedValue(new Error('agent failed')),
    };

    instrumentOpenAIAgents(agent, client);

    await expect(agent.run('input')).rejects.toThrow('agent failed');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].status).toBe('error');
    expect(body.spans[0].attributes['error.message']).toBe('agent failed');
    expect(body.spans[0].attributes['error.name']).toBe('Error');
  });

  it('sets error.type attribute when run() throws', async () => {
    const agent = { name: 'helper', run: vi.fn().mockRejectedValue(new Error('fetch failed')) };
    instrumentOpenAIAgents(agent, client);

    await expect(agent.run('input')).rejects.toThrow('fetch failed');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const agentSpan = body.spans.find((s) => s.kind === 'agent_step')!;
    expect(agentSpan.attributes['error.type']).toBe('network_error');
  });

  it('is idempotent — second call does not double-wrap', async () => {
    const agent = { name: 'A', run: vi.fn().mockResolvedValue({}) };

    instrumentOpenAIAgents(agent, client);
    instrumentOpenAIAgents(agent, client);

    await agent.run('x');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans).toHaveLength(1);
  });

  it('creates tool_call child spans for each tool in agent.tools', async () => {
    const toolFn = vi.fn().mockResolvedValue('result-from-tool');
    const agent = {
      name: 'SupportAgent',
      model: 'gpt-4o',
      tools: [{ name: 'search_web', on_invoke_tool: toolFn }],
      run: vi.fn().mockImplementation(async function (this: unknown) {
        await (this as any).tools[0].on_invoke_tool({}, JSON.stringify({ query: 'test' }));
        return { output: 'done' };
      }),
    };

    instrumentOpenAIAgents(agent, client);
    await agent.run('User question');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const agentSpan = body.spans.find((s) => s.name === 'agent.SupportAgent')!;
    const toolSpan = body.spans.find((s) => s.name === 'tool.search_web')!;

    expect(toolSpan).toBeDefined();
    expect(toolSpan.kind).toBe('tool_call');
    expect(toolSpan.attributes['tool.name']).toBe('search_web');
    expect(toolSpan.parentSpanId).toBe(agentSpan.id);
    expect(toolSpan.traceId).toBe(agentSpan.traceId);
  });

  it('records handoff.target_agent on agent span when transfer_to_ tool is called', async () => {
    const handoffFn = vi.fn().mockResolvedValue(null);
    const agent = {
      name: 'TriageAgent',
      tools: [{ name: 'transfer_to_BillingAgent', on_invoke_tool: handoffFn }],
      run: vi.fn().mockImplementation(async function (this: unknown) {
        await (this as any).tools[0].on_invoke_tool({}, '{}');
        return { output: 'transferred' };
      }),
    };

    instrumentOpenAIAgents(agent, client);
    await agent.run('billing issue');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const agentSpan = body.spans.find((s) => s.name === 'agent.TriageAgent')!;

    expect(agentSpan.attributes['handoff.target_agent']).toBe('BillingAgent');
  });

  it('propagates traceId to nested agent runs via runWithContext', async () => {
    const innerAgent = {
      name: 'InnerAgent',
      run: vi.fn().mockResolvedValue({ output: 'inner done' }),
    };
    const outerAgent = {
      name: 'OuterAgent',
      run: vi.fn().mockImplementation(async function () {
        await innerAgent.run('sub-task');
        return { output: 'outer done' };
      }),
    };

    instrumentOpenAIAgents(outerAgent, client);
    instrumentOpenAIAgents(innerAgent, client);

    await outerAgent.run('main task');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const outerSpan = body.spans.find((s) => s.name === 'agent.OuterAgent')!;
    const innerSpan = body.spans.find((s) => s.name === 'agent.InnerAgent')!;

    expect(innerSpan.traceId).toBe(outerSpan.traceId);
    expect(innerSpan.parentSpanId).toBe(outerSpan.id);
  });

  it('records error on tool span when tool throws', async () => {
    const toolFn = vi.fn().mockRejectedValue(new Error('tool exploded'));
    const agent = {
      name: 'ErrorAgent',
      tools: [{ name: 'risky_tool', on_invoke_tool: toolFn }],
      run: vi.fn().mockImplementation(async function (this: unknown) {
        try {
          await (this as any).tools[0].on_invoke_tool({}, '{}');
        } catch { /* agent handles error */ }
        return { output: 'recovered' };
      }),
    };

    instrumentOpenAIAgents(agent, client);
    await agent.run('task');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolSpan = body.spans.find((s) => s.name === 'tool.risky_tool')!;

    expect(toolSpan.status).toBe('error');
    expect(toolSpan.attributes['error.message']).toBe('tool exploded');
    expect(toolSpan.attributes['error.name']).toBe('Error');
  });

  it('links to parent trace via AsyncLocalStorage', async () => {
    const agent = { name: 'InnerAgent', run: vi.fn().mockResolvedValue({}) };
    instrumentOpenAIAgents(agent, client);

    const trace = client.startTrace({ name: 'pipeline' });
    await trace.trace('orchestrate', async () => {
      await agent.run('task');
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const agentSpan = body.spans.find((s) => s.name === 'agent.InnerAgent')!;
    const parentSpan = body.spans.find((s) => s.name === 'orchestrate')!;

    expect(agentSpan.parentSpanId).toBe(parentSpan.id);
    expect(agentSpan.traceId).toBe(parentSpan.traceId);
  });

  it('propagates tenantId from active trace context to agent_step span', async () => {
    const agent = { name: 'BillingAgent', run: vi.fn().mockResolvedValue({}) };
    instrumentOpenAIAgents(agent, client);

    const trace = client.startTrace({ name: 'pipeline', tenantId: 'tenant-xyz' });

    await trace.trace('orchestrate', async () => {
      await agent.run('task');
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const agentSpan = body.spans.find((s) => s.name === 'agent.BillingAgent')!;
    expect(agentSpan.tenantId).toBe('tenant-xyz');
  });

  it('propagates tenantId to tool_call spans via runWithContext', async () => {
    const toolFn = vi.fn().mockResolvedValue('ok');
    const agent = {
      name: 'ToolAgent',
      tools: [{ name: 'do_thing', on_invoke_tool: toolFn }],
      run: vi.fn().mockImplementation(async function (this: unknown) {
        await (this as any).tools[0].on_invoke_tool({}, '{}');
        return {};
      }),
    };

    instrumentOpenAIAgents(agent, client);

    const trace = client.startTrace({ name: 'run', tenantId: 'tenant-abc' });
    await trace.trace('step', async () => {
      await agent.run('go');
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolSpan = body.spans.find((s) => s.name === 'tool.do_thing')!;
    expect(toolSpan.tenantId).toBe('tenant-abc');
  });

  it('auto-instruments handoff target agents so trace propagates through handoffs', async () => {
    const billingAgent: any = {
      name: 'billing',
      run: vi.fn().mockResolvedValue('billing done'),
    };
    const triageAgent: any = {
      name: 'triage',
      handoffs: [billingAgent],
      run: vi.fn().mockImplementation(async () => billingAgent.run('handed off')),
    };
    instrumentOpenAIAgents(triageAgent, client);

    await triageAgent.run('help me with my invoice');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const triageSpan = body.spans.find((s) => s.name === 'agent.triage')!;
    const billingSpan = body.spans.find((s) => s.name === 'agent.billing')!;
    expect(billingSpan.traceId).toBe(triageSpan.traceId);
    expect(billingSpan.parentSpanId).toBe(triageSpan.id);
  });

  it('supports handoff objects wrapping the agent ({ agent } shape)', async () => {
    const target: any = { name: 'refunds', run: vi.fn().mockResolvedValue('ok') };
    const source: any = {
      name: 'support',
      handoffs: [{ agent: target, toolName: 'transfer_to_refunds' }],
      run: vi.fn().mockResolvedValue('ok'),
    };
    instrumentOpenAIAgents(source, client);

    await target.run('direct call after handoff');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans.some((s) => s.name === 'agent.refunds')).toBe(true);
  });

  it('sets handoff.target_agent attribute on the transfer_to_ tool span', async () => {
    const transferTool: any = {
      name: 'transfer_to_billing',
      on_invoke_tool: vi.fn().mockResolvedValue('transferred'),
    };
    const agent: any = {
      name: 'triage',
      tools: [transferTool],
      run: vi.fn().mockImplementation(async () => transferTool.on_invoke_tool({}, '{}')),
    };
    instrumentOpenAIAgents(agent, client);

    await agent.run('input');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolSpan = body.spans.find((s) => s.kind === 'tool_call')!;
    expect(toolSpan.attributes['handoff.target_agent']).toBe('billing');
  });

  it('does not infinitely recurse on mutual handoff cycles (A <-> B)', async () => {
    const agentA: any = { name: 'a', handoffs: [] as any[], run: vi.fn().mockResolvedValue('ok') };
    const agentB: any = { name: 'b', handoffs: [agentA], run: vi.fn().mockResolvedValue('ok') };
    agentA.handoffs.push(agentB);

    expect(() => instrumentOpenAIAgents(agentA, client)).not.toThrow();

    await agentA.run('x');
    await agentB.run('y');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans.map((s: any) => s.name).sort()).toEqual(['agent.a', 'agent.b']);
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
        { name: 'transfer_to_billing', on_invoke_tool: vi.fn().mockResolvedValue(null) },
        { name: 'transfer_to_refunds', on_invoke_tool: vi.fn().mockResolvedValue(null) },
      ],
      run: vi.fn().mockImplementation(async (which: string) => {
        if (which === 'A') {
          await agent.tools[0].on_invoke_tool({}, '{}'); // billing
          await aHolding;
          return 'A';
        }
        await agent.tools[1].on_invoke_tool({}, '{}'); // refunds
        return 'B';
      }),
    };
    instrumentOpenAIAgents(agent, client);

    const pA = agent.run('A'); // records billing, then parks at the barrier
    await new Promise((r) => setTimeout(r, 0)); // let A reach the barrier
    await agent.run('B'); // records refunds and completes while A holds
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

  it('instruments a Runner: creates agent_step span named after the passed agent', async () => {
    const agent: any = { name: 'assistant', model: 'gpt-4o', tools: [] };
    const runner: any = {
      run: vi.fn().mockResolvedValue({ finalOutput: 'done' }),
    };
    instrumentOpenAIAgents(runner, client);

    const result = await runner.run(agent, 'user input');
    expect(result).toEqual({ finalOutput: 'done' });
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans[0];
    expect(span.name).toBe('agent.assistant');
    expect(span.kind).toBe('agent_step');
    expect(span.attributes['agent.name']).toBe('assistant');
    expect(span.attributes['openai.model']).toBe('gpt-4o');
  });

  it('Runner patch instruments the passed agent tools (tool spans are children of run span)', async () => {
    const tool: any = { name: 'search', on_invoke_tool: vi.fn().mockResolvedValue('found') };
    const agent: any = { name: 'assistant', tools: [tool] };
    const runner: any = {
      run: vi.fn().mockImplementation(async (a: any) => a.tools[0].on_invoke_tool({}, '{"q":"x"}')),
    };
    instrumentOpenAIAgents(runner, client);

    await runner.run(agent, 'input');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const runSpan = body.spans.find((s) => s.kind === 'agent_step')!;
    const toolSpan = body.spans.find((s) => s.kind === 'tool_call')!;
    expect(toolSpan.parentSpanId).toBe(runSpan.id);
    expect(toolSpan.traceId).toBe(runSpan.traceId);
  });

  it('runner instrumentation is idempotent and records errors with error.type', async () => {
    const agent: any = { name: 'assistant' };
    const runner: any = { run: vi.fn().mockRejectedValue(new Error('rate limit exceeded')) };
    instrumentOpenAIAgents(runner, client);
    instrumentOpenAIAgents(runner, client);

    await expect(runner.run(agent, 'x')).rejects.toThrow('rate limit');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0].status).toBe('error');
    expect(body.spans[0].attributes['error.type']).toBe('rate_limit');
  });
});
