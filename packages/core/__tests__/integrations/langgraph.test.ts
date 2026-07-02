import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instrumentLangGraph } from '../../src/integrations/langgraph.js';
import { TracelyxClient } from '../../src/client.js';
import type { TracePayload } from '../../src/types.js';

function makeGraphMock(returnValue: unknown) {
  return { invoke: vi.fn().mockResolvedValue(returnValue) };
}

describe('instrumentLangGraph', () => {
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

  it('wraps invoke() and creates an agent_step span', async () => {
    const graph = makeGraphMock({ result: 'done' });
    instrumentLangGraph(graph, client);

    await graph.invoke({ input: 'hello' }, { configurable: { thread_id: 'thread-1' } });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans[0];

    expect(span.kind).toBe('agent_step');
    expect(span.name).toBe('langgraph.invoke');
    expect(span.attributes['langgraph.thread_id']).toBe('thread-1');
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
    expect(span.status).toBe('ok');
  });

  it('records error status when invoke throws', async () => {
    const graph = { invoke: vi.fn().mockRejectedValue(new Error('graph failed')) };
    instrumentLangGraph(graph, client);

    await expect(graph.invoke({})).rejects.toThrow('graph failed');

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].status).toBe('error');
    expect(body.spans[0].attributes['error.message']).toBe('graph failed');
  });

  it('sets error.type attribute when invoke throws', async () => {
    const graph = { invoke: vi.fn().mockRejectedValue(new Error('rate limit exceeded')) };
    instrumentLangGraph(graph, client);

    await expect(graph.invoke({})).rejects.toThrow('rate limit');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].attributes['error.type']).toBe('rate_limit');
  });

  it('is idempotent — second call does not double-wrap', async () => {
    const graph = makeGraphMock({});
    instrumentLangGraph(graph, client);
    instrumentLangGraph(graph, client);

    await graph.invoke({});
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans).toHaveLength(1);
  });

  it('creates per-node spans for each update when stream() is called', async () => {
    async function* fakeStream() {
      yield { researcher: { results: ['a', 'b'] } };
      yield { writer: { content: 'hello world' } };
    }

    const graph = {
      invoke: vi.fn().mockResolvedValue({ writer: { content: 'hello world' } }),
      stream: vi.fn().mockReturnValue(fakeStream()),
    };

    instrumentLangGraph(graph, client);

    const chunks: unknown[] = [];
    for await (const chunk of (graph as any).stream({ input: 'query' }, { streamMode: 'updates' })) {
      chunks.push(chunk);
    }

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const nodeSpans = body.spans.filter((s) => s.name.startsWith('langgraph.node.'));

    expect(nodeSpans).toHaveLength(2);
    expect(nodeSpans.find((s) => s.name === 'langgraph.node.researcher')).toBeDefined();
    expect(nodeSpans.find((s) => s.name === 'langgraph.node.writer')).toBeDefined();
    nodeSpans.forEach((s) => {
      expect(s.kind).toBe('agent_step');
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('node spans are children of invoke span when stream is called via invoke', async () => {
    let streamCalled = false;
    async function* fakeStream() {
      streamCalled = true;
      yield { nodeA: { x: 1 } };
    }

    const graph = {
      invoke: vi.fn().mockImplementation(async function (this: unknown, input: unknown, config: unknown) {
        for await (const _chunk of (this as any).stream(input, config)) { /* consume */ }
        return { nodeA: { x: 1 } };
      }),
      stream: vi.fn().mockReturnValue(fakeStream()),
    };

    instrumentLangGraph(graph, client);

    await graph.invoke({ input: 'hello' }, { configurable: { thread_id: 't1' } });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const invokeSpan = body.spans.find((s) => s.name === 'langgraph.invoke')!;
    const nodeSpan = body.spans.find((s) => s.name === 'langgraph.node.nodeA')!;

    expect(streamCalled).toBe(true);
    expect(nodeSpan).toBeDefined();
    expect(nodeSpan.parentSpanId).toBe(invokeSpan.id);
    expect(nodeSpan.traceId).toBe(invokeSpan.traceId);
  });

  it('emits console.warn when streamEvents is absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const graph = {
      invoke: vi.fn().mockResolvedValue({}),
      stream: vi.fn(),
    };

    instrumentLangGraph(graph, client);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('streamEvents'));

    warnSpy.mockRestore();
  });

  it('does NOT warn when streamEvents is present', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const graph = {
      invoke: vi.fn().mockResolvedValue({}),
      stream: vi.fn(),
      streamEvents: vi.fn(),
    };

    instrumentLangGraph(graph, client);

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('links to parent trace when called inside trace.trace()', async () => {
    const graph = makeGraphMock({});
    instrumentLangGraph(graph, client);

    const trace = client.startTrace({ name: 'outer' });
    await trace.trace('orchestrate', async () => {
      await graph.invoke({});
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const lgSpan = body.spans.find((s) => s.name === 'langgraph.invoke')!;
    const parentSpan = body.spans.find((s) => s.name === 'orchestrate')!;

    expect(lgSpan.parentSpanId).toBe(parentSpan.id);
    expect(lgSpan.traceId).toBe(parentSpan.traceId);
  });

  it('propagates tenantId from active trace context to invoke span', async () => {
    const graph = makeGraphMock({});
    instrumentLangGraph(graph, client);

    const trace = client.startTrace({ name: 'run', tenantId: 'tenant-lg' });

    await trace.trace('step', async () => {
      await graph.invoke({ input: 'x' });
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const lgSpan = body.spans.find((s) => s.name === 'langgraph.invoke')!;
    expect(lgSpan.tenantId).toBe('tenant-lg');
  });

  it('nested instrumented subgraph invoke becomes a child span of parent invoke', async () => {
    const subgraph: any = { invoke: vi.fn().mockResolvedValue({ sub: 'done' }) };
    instrumentLangGraph(subgraph, client);

    const parent: any = {
      invoke: vi.fn().mockImplementation(async () => {
        // węzeł grafu rodzica wywołuje subgraf
        return subgraph.invoke({ nested: true });
      }),
    };
    instrumentLangGraph(parent, client);

    await parent.invoke({ input: 'top' });
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans).toHaveLength(2);

    const spans = [...body.spans].sort((a, b) => (a.parentSpanId === null ? -1 : 1));
    const [parentSpan, childSpan] = spans;
    expect(parentSpan.parentSpanId).toBeNull();
    expect(childSpan.parentSpanId).toBe(parentSpan.id);
    expect(childSpan.traceId).toBe(parentSpan.traceId);
  });

  it('node spans carry langgraph.node_name and langgraph.thread_id from config', async () => {
    async function* fakeStream() {
      yield { researcher: { results: ['a'] } };
    }
    const graph = {
      invoke: vi.fn().mockResolvedValue({}),
      stream: vi.fn().mockReturnValue(fakeStream()),
    };
    instrumentLangGraph(graph, client);

    for await (const _chunk of (graph as any).stream({}, { configurable: { thread_id: 'thread-42' } })) {
      // drain
    }
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const nodeSpan = body.spans.find((s) => s.name === 'langgraph.node.researcher')!;
    expect(nodeSpan.attributes['langgraph.node_name']).toBe('researcher');
    expect(nodeSpan.attributes['langgraph.node']).toBe('researcher');
    expect(nodeSpan.attributes['langgraph.thread_id']).toBe('thread-42');
  });

  it('streamEvents patch emits node spans with accurate start/end pairing by run_id', async () => {
    async function* fakeEvents() {
      yield { event: 'on_chain_start', name: 'LangGraph', run_id: 'root', metadata: {} };
      yield { event: 'on_chain_start', name: 'researcher', run_id: 'r1', metadata: { langgraph_node: 'researcher' } };
      yield { event: 'on_chain_end', name: 'researcher', run_id: 'r1', metadata: { langgraph_node: 'researcher' } };
      yield { event: 'on_chain_start', name: 'writer', run_id: 'w1', metadata: { langgraph_node: 'writer' } };
      yield { event: 'on_chain_end', name: 'writer', run_id: 'w1', metadata: { langgraph_node: 'writer' } };
      yield { event: 'on_chain_end', name: 'LangGraph', run_id: 'root', metadata: {} };
    }
    const graph = {
      invoke: vi.fn().mockResolvedValue({}),
      stream: vi.fn(),
      streamEvents: vi.fn().mockReturnValue(fakeEvents()),
    };
    instrumentLangGraph(graph, client);

    const seen: unknown[] = [];
    for await (const ev of (graph as any).streamEvents({}, { version: 'v2' })) {
      seen.push(ev);
    }
    await client.flush();

    expect(seen).toHaveLength(6); // eventy przechodzą nietknięte

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const names = body.spans.map((s) => s.name).sort();
    expect(names).toEqual(['langgraph.node.researcher', 'langgraph.node.writer']);
    for (const span of body.spans) {
      expect(span.kind).toBe('agent_step');
      expect(span.attributes['langgraph.node_name']).toBeDefined();
      expect(span.endTime).toBeGreaterThanOrEqual(span.startTime);
    }
  });

  it('streamEvents ignores unmatched on_chain_end and non-node events', async () => {
    async function* fakeEvents() {
      yield { event: 'on_chat_model_stream', name: 'ChatAnthropic', run_id: 'x1', metadata: {} };
      yield { event: 'on_chain_end', name: 'ghost', run_id: 'never-started', metadata: { langgraph_node: 'ghost' } };
    }
    const graph = {
      invoke: vi.fn().mockResolvedValue({}),
      streamEvents: vi.fn().mockReturnValue(fakeEvents()),
    };
    instrumentLangGraph(graph, client);

    for await (const _ev of (graph as any).streamEvents({})) {
      // drain
    }
    await client.flush();

    expect(fetchMock).not.toHaveBeenCalled(); // zero spanów
  });
});
