import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, Runner, tool, handoff, Usage } from '@openai/agents';
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

  it('captures handoff.target_agent from a real handoff(agent) via Handoff.onInvokeHandoff', async () => {
    // Real handoffs are Handoff instances stored in agent.handoffs (a SEPARATE array from
    // agent.tools). The runner calls Handoff.onInvokeHandoff at handoff time to resolve the
    // next agent. With no inputType, onInvokeHandoff just returns the target agent, so we can
    // exercise it network-free with a fake run context.
    const billing = new Agent({ name: 'billing' });
    const theHandoff = handoff(billing);
    const source = new Agent({ name: 'triage', handoffs: [theHandoff] });

    // Instrumenting the source agent must wrap the Handoff instance stored on source.handoffs.
    instrumentOpenAIAgents(source, client);

    // Resolve the handoff through the SDK's OWN lookup — the exact path Runner.run uses
    // (runImplementation → agent.getEnabledHandoffs → handoffMap → toolExecution invokes
    // handoff.onInvokeHandoff). This guards that the object we mutate in place is the one the
    // runtime actually resolves and invokes — not merely that our wrapper works when called
    // directly. `getEnabledHandoffs` is network-free here: getHandoff() returns the same Handoff
    // instance and the default `isEnabled` is `async () => true` (ignores the run context).
    const enabled = await (
      source as unknown as {
        getEnabledHandoffs: (
          ctx: unknown,
        ) => Promise<Array<{ onInvokeHandoff(ctx: unknown, args: string): Promise<unknown> }>>;
      }
    ).getEnabledHandoffs({});
    // The runtime resolves to the very Handoff object we wrapped in place.
    expect(enabled[0]).toBe(
      (source as unknown as { handoffs: unknown[] }).handoffs[0],
    );

    // Invoke inside an active run context so the handoff span links to it and the aggregate
    // Set is fed (mirrors the runner calling onInvokeHandoff within Runner.run).
    const trace = client.startTrace({ name: 'run', tenantId: 'tenant-h' });
    const returned = await trace.trace('agent-run', async () =>
      enabled[0].onInvokeHandoff({} as unknown, '{}'),
    );
    await client.flush();

    // The wrapper must preserve the original return value: the real billing Agent instance.
    expect(returned).toBe(billing);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body ?? '{"spans":[]}') as TracePayload;
    const handoffSpan = body.spans.find((s) => s.attributes['handoff.target_agent'] === 'billing');
    expect(handoffSpan).toBeDefined();
    expect(handoffSpan!.name).toBe('handoff.billing');
    expect(handoffSpan!.kind).toBe('agent_step');
    expect(handoffSpan!.tenantId).toBe('tenant-h');
  });

  // extractUsage() (src/integrations/openai-agents.ts) reads result.runContext.usage.inputTokens /
  // .outputTokens off a plain-object mock in openai-agents.test.ts. That pins the shape against a
  // hand-rolled fake only. Here we construct a REAL `Usage` from `@openai/agents` (not a fake with
  // matching field names) so a future rename/relocation of Usage's token fields breaks this test in
  // CI, without needing a live model call.
  it('extractUsage reads tokens from a REAL @openai/agents Usage shape', async () => {
    // Usage's constructor accepts inputTokens/outputTokens directly (see usage.d.ts /
    // usage.js: `this.inputTokens = input?.inputTokens ?? input?.input_tokens ?? 0`).
    const usage = new Usage({ inputTokens: 12, outputTokens: 3 });
    expect(usage.inputTokens).toBe(12);
    expect(usage.outputTokens).toBe(3);

    const agent = new Agent({ name: 'assistant', model: 'gpt-4o' });
    const runner = { run: vi.fn().mockResolvedValue({ runContext: { usage } }) };
    instrumentOpenAIAgents(runner, client);

    await runner.run(agent, 'x');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body ?? '{"spans":[]}') as TracePayload;
    const span = body.spans.find((s) => s.kind === 'agent_step')!;
    expect(span.promptTokens).toBe(12);
    expect(span.completionTokens).toBe(3);
    expect(span.attributes['llm.prompt_tokens']).toBe(12);
    expect(span.attributes['llm.completion_tokens']).toBe(3);
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
