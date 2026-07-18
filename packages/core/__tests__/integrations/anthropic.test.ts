import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instrumentAnthropic } from '../../src/integrations/anthropic.js';
import { TracelyxClient } from '../../src/client.js';
import type { TracePayload } from '../../src/types.js';
import {
  accumulateStreamEvent,
  newStreamState,
} from '../../src/integrations/anthropic.js';

const STREAM_EVENTS = [
  { type: 'message_start', message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 12, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', usage: { output_tokens: 7 } },
  { type: 'message_stop' },
];

function makeAnthropicMock(response: unknown) {
  return { messages: { create: vi.fn().mockResolvedValue(response) } };
}

const OK_RESPONSE = {
  content: [{ type: 'text', text: 'Hello' }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('instrumentAnthropic', () => {
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

  it('patches messages.create and creates a llm_call span', async () => {
    const anthropic = makeAnthropicMock(OK_RESPONSE);
    instrumentAnthropic(anthropic, client);

    await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    await client.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans[0];

    expect(span.kind).toBe('llm_call');
    expect(span.name).toBe('anthropic.messages.create');
    expect(span.attributes['llm.model']).toBe('claude-3-5-sonnet-20241022');
    expect(span.attributes['llm.prompt_tokens']).toBe(10);
    expect(span.attributes['llm.completion_tokens']).toBe(5);
    expect(span.inputPayload).toBe(JSON.stringify([{ role: 'user', content: 'Hi' }]));
    expect(span.outputPayload).toBe(JSON.stringify(OK_RESPONSE.content));
    expect(span.llmModel).toBe('claude-3-5-sonnet-20241022');
    expect(span.promptTokens).toBe(10);
    expect(span.completionTokens).toBe(5);
    expect(span.attributes['llm.system_prompt_hash']).toMatch(/^[a-f0-9]{32}$/);
  });

  it('is idempotent — second call does not duplicate spans', async () => {
    const anthropic = makeAnthropicMock(OK_RESPONSE);
    instrumentAnthropic(anthropic, client);
    instrumentAnthropic(anthropic, client); // second call

    await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'x' }],
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans).toHaveLength(1);
  });

  it('records error status when create throws', async () => {
    const anthropic = { messages: { create: vi.fn().mockRejectedValue(new Error('API Error')) } };
    instrumentAnthropic(anthropic, client);

    await expect(
      anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [],
      }),
    ).rejects.toThrow('API Error');

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].status).toBe('error');
    expect(body.spans[0].attributes['error.message']).toBe('API Error');
    expect(body.spans[0].attributes['error.name']).toBe('Error');
  });

  it('sets error.type from classifyError when create rejects', async () => {
    const anthropic = {
      messages: { create: vi.fn().mockRejectedValue(Object.assign(new Error('rate limit exceeded'), { status: 429 })) },
    };
    instrumentAnthropic(anthropic, client);

    await expect(anthropic.messages.create({ model: 'm', max_tokens: 1, messages: [] })).rejects.toThrow('rate limit');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].attributes['error.type']).toBe('rate_limit');
  });

  it('links span to parent trace via AsyncLocalStorage when called inside trace.trace()', async () => {
    const anthropic = makeAnthropicMock(OK_RESPONSE);
    instrumentAnthropic(anthropic, client);

    const trace = client.startTrace({ name: 'parent-trace' });

    await trace.trace('agent-step', async () => {
      await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      });
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const llmSpan = body.spans.find((s) => s.kind === 'llm_call')!;
    const parentSpan = body.spans.find((s) => s.name === 'agent-step')!;

    expect(llmSpan.parentSpanId).toBe(parentSpan.id);
    expect(llmSpan.traceId).toBe(parentSpan.traceId);
  });

  it('creates standalone span (no parent) when called outside trace.trace()', async () => {
    const anthropic = makeAnthropicMock(OK_RESPONSE);
    instrumentAnthropic(anthropic, client);

    await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 10,
      messages: [],
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].parentSpanId).toBeNull();
  });

  it('propagates tenantId from active trace context to llm_call span', async () => {
    const anthropic = makeAnthropicMock(OK_RESPONSE);
    instrumentAnthropic(anthropic, client);

    const trace = client.startTrace({ name: 'run', tenantId: 'acme-corp' });

    await trace.trace('agent-step', async () => {
      await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      });
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const llmSpan = body.spans.find((s) => s.kind === 'llm_call')!;
    expect(llmSpan.tenantId).toBe('acme-corp');
  });

  it('emits agent.declared_tools attribute when tools are passed', async () => {
    const anthropic = makeAnthropicMock(OK_RESPONSE);
    instrumentAnthropic(anthropic, client);

    await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
        { name: 'write_file', description: 'Write a file', input_schema: { type: 'object', properties: {} } },
      ],
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans[0];
    expect(span.attributes['agent.declared_tools']).toEqual(['read_file', 'write_file']);
  });

  it('emits llm.tool_call_name when response contains a tool_use block', async () => {
    const toolUseResponse = {
      content: [
        { type: 'tool_use', id: 'tu_01', name: 'read_file', input: { path: '/etc/hosts' } },
      ],
      usage: { input_tokens: 20, output_tokens: 8 },
    };
    const anthropic = makeAnthropicMock(toolUseResponse);
    instrumentAnthropic(anthropic, client);

    await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Read /etc/hosts' }],
      tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans[0];
    expect(span.attributes['llm.tool_call_name']).toBe('read_file');
    expect(span.attributes['agent.declared_tools']).toEqual(['read_file']);
  });

  it('does not emit tool attributes when no tools are passed', async () => {
    const anthropic = makeAnthropicMock(OK_RESPONSE);
    instrumentAnthropic(anthropic, client);

    await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const span = body.spans[0];
    expect(span.attributes['agent.declared_tools']).toBeUndefined();
    expect(span.attributes['llm.tool_call_name']).toBeUndefined();
  });
});

describe('accumulateStreamEvent', () => {
  it('reconstructs text content and tokens from a full event sequence', () => {
    const state = newStreamState();
    for (const e of STREAM_EVENTS) accumulateStreamEvent(state, e);

    expect(state.inputTokens).toBe(12);
    expect(state.outputTokens).toBe(7);
    expect(state.model).toBe('claude-3-5-sonnet-20241022');
    expect(state.sawStop).toBe(true);
    expect(state.blocks.filter(Boolean)).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('reconstructs tool_use input from input_json_delta fragments', () => {
    const state = newStreamState();
    const events = [
      { type: 'message_start', message: { model: 'm', usage: { input_tokens: 20 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"/etc/hosts"}' } },
      { type: 'content_block_stop', index: 0 },
    ];
    for (const e of events) accumulateStreamEvent(state, e);

    expect(state.blocks[0]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/etc/hosts' } });
  });

  it('marks sawStop false when the stream never completes', () => {
    const state = newStreamState();
    accumulateStreamEvent(state, STREAM_EVENTS[0]);
    accumulateStreamEvent(state, STREAM_EVENTS[1]);
    expect(state.sawStop).toBe(false);
  });
});
