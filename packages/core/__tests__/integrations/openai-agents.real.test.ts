import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';
import { TracelyxClient } from '../../src/client.js';
import { instrumentOpenAIAgents } from '../../src/integrations/openai-agents.js';
import type { TracePayload } from '../../src/types.js';

// Sieciowo-niezależny kontrakt na REALNYM @openai/agents.
// Chroni przed rozjazdem: kod SDK-a używa .invoke (nie on_invoke_tool),
// a Agent nie ma .run (wykonanie przez Runner.run / run()).
describe('instrumentOpenAIAgents — real @openai/agents shapes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: TracelyxClient;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{"accepted":1}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    client = new TracelyxClient({ apiKey: 'tl_test', projectId: 'proj_1' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a real Agent has no .run method (regression guard for the original bug)', () => {
    const agent = new Agent({ name: 'A' });
    expect((agent as unknown as { run?: unknown }).run).toBeUndefined();
  });

  it('a real function tool exposes .invoke and NOT on_invoke_tool', () => {
    const t = tool({ name: 'echo', description: 'x', parameters: z.object({}), execute: async () => 'ok' });
    expect(typeof (t as unknown as { invoke?: unknown }).invoke).toBe('function');
    expect((t as unknown as { on_invoke_tool?: unknown }).on_invoke_tool).toBeUndefined();
  });

  it('a real Runner exposes .run(agent, input)', () => {
    expect(typeof new Runner().run).toBe('function');
  });

  it('instruments a real Agent and wraps its tools for tool_call spans', async () => {
    const echo = tool({ name: 'echo', description: 'x', parameters: z.object({}), execute: async () => 'ok' });
    const agent = new Agent({ name: 'assistant', tools: [echo] });

    // Real Agent has no .run — the dispatcher must wrap tools, not patch a run method.
    expect(() => instrumentOpenAIAgents(agent, client)).not.toThrow();

    await (echo as unknown as { invoke(ctx: unknown, input: string): Promise<unknown> }).invoke({}, '{}');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body ?? '{"spans":[]}') as TracePayload;
    const toolSpan = body.spans.find((s) => s.kind === 'tool_call');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes['tool.name']).toBe('echo');
  });

  // Full Runner.run loop needs a live model/network. Gated behind an explicit opt-in flag
  // (not merely the presence of OPENAI_API_KEY, which many dev machines have set) so normal
  // runs stay network-free; the shape guards + tool-wrap test above are the hard contract.
  it.skipIf(!process.env.TRACELYX_LIVE_OPENAI)(
    'instruments a real Runner instance: emits agent_step named after the agent',
    async () => {
      const runner = new Runner();
      const agent = new Agent({ name: 'assistant', model: 'gpt-4o' });
      instrumentOpenAIAgents(runner, client);

      const originalRun = (runner as unknown as { run: unknown }).run;
      expect(typeof originalRun).toBe('function');

      await runner.run(agent, 'hi').catch(() => {});
      await client.flush();

      const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body ?? '{"spans":[]}') as TracePayload;
      const span = body.spans.find((s) => s.kind === 'agent_step');
      expect(span).toBeDefined();
      expect(span!.name).toBe('agent.assistant');
      expect(span!.attributes['openai.model']).toBe('gpt-4o');
    },
  );
});
