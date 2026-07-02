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
});
