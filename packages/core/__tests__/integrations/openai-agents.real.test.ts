import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';
import { TracelyxClient } from '../../src/client.js';

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
});
