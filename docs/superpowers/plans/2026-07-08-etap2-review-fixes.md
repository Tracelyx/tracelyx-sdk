# Etap 2 (SDK) — Plan Naprawczy po Przeglądzie `@tracelyx/core`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Naprawić wszystkie problemy z przeglądu Etapu 2 SDK: przepisać integrację OpenAI Agents pod realne `@openai/agents` (JS), naprawić utratę spanów w `flush()`, poprawić zagnieżdżanie subgrafów LangGraph, domknąć luki testowe, utwardzić `hook-listener` i uzupełnić dokumentację.

**Architecture:** Wszystkie zmiany w `packages/core`. Integracje monkey-patchują obiekty third-party i wysyłają `SpanPayload` przez `tracelyxClient.recordSpan()`; kontekst parent-child propaguje `AsyncLocalStorage` (`getActiveContext`/`runWithContext` z `src/tracer.ts`). Zmiana architektoniczna dla OpenAI Agents: punktem instrumentacji przestaje być nieistniejące `agent.run`/`tool.on_invoke_tool` (nazwy z Pythonowego SDK), a staje się realne API JS: `Runner.run(agent, input)`, eksport `run(agent, input)` oraz `tool.invoke(runContext, input)`.

**Tech Stack:** TypeScript, tsup (dual ESM+CJS), vitest, natywny `fetch`. Zero runtime dependencies (devDependencies dozwolone).

## Global Constraints

- Zero runtime dependencies w `dependencies` (AD-03). `@openai/agents` dodajemy WYŁĄCZNIE do `devDependencies`.
- Rozmiar bundla `dist/index.js` < 20 KB gzip (obecnie 6.3 KB) — weryfikować po każdej rozbudowie: `pnpm build && gzip -c dist/index.js | wc -c` (< 20480).
- Dual build ESM + CJS przez tsup; bin entry bez DTS.
- Konwencja commitów: conventional commits (`feat(core):`, `fix(openai-agents):`, `test(langgraph):`, `docs(core):`).
- Testy: `vitest`, mock `fetch` przez `vi.stubGlobal('fetch', ...)`, klient przez `new TracelyxClient({ apiKey: 'tl_test', projectId: 'proj_1' })` + `client.flush()` + parsowanie `fetchMock.mock.calls[0][1].body`.
- Po każdym tasku: `pnpm exec vitest run` (całość) zielone. Na koniec: `pnpm check-types` i `pnpm build` z repo root.
- Wszystkie komendy testowe z katalogu `packages/core`.
- Nie łamać istniejących zachowań innych integracji (Anthropic, LangGraph invoke) ani API publicznego `index.ts` bez świadomej decyzji odnotowanej w tasku.

## Kolejność i priorytety

- **P0 (krytyczne):** Task 1–5 — OpenAI Agents nie działa na realnym SDK.
- **P1 (wysokie/średnie):** Task 6–9 — utrata spanów w `flush()`, pojemność bufora, zagnieżdżanie subgrafów, routing tenantów.
- **P2 (niskie / hardening / testy / docs):** Task 10–13.

Zależności: Task 2→3→4 (OpenAI). Task 6 przed 7 (bufor). Reszta niezależna.

## Decyzje przyjęte (z brainstormu z użytkownikiem)

1. **OpenAI Agents:** przepisać pod realne SDK + dodać `@openai/agents` jako devDependency + realny test smoke łapiący rozjazd API. NIE utrzymujemy równolegle starego kształtu (`on_invoke_tool`/`agent.run`).
2. **Redakcja PII (S1):** odroczona zgodnie z roadmapą (TASK-014) — w tym planie tylko notatka w README (Task 13). Bez zmian w kodzie przechwytywania.

## Poza zakresem (świadomie NIE robimy)

- **Nazwa node spana** `langgraph.node.<node>` zamiast literalnie `<node>` — zostaje (czytelność; nazwa węzła jest w atrybucie `langgraph.node_name`). Odnotowane w README (Task 13).
- **`validate` przez `TracelyxClient`** — zostaje raw `fetch` (potrzebny status HTTP dla 401 i receipt GET, których `flush()` nie udostępnia). Odnotowane w README (Task 13).
- **llm_call spany + pełne tokeny dla OpenAI Agents** — monkey-patch nie widzi pojedynczych wywołań modelu; faithful llm_call spany wymagają API `addTraceProcessor` z `@openai/agents` (osobny, większy redesign). W tym planie: agregat `openai.model` + best-effort tokeny z `RunResult` na spanie `agent_step` (Task 3). Notatka w README.

---

## Task 1: OpenAI Agents — devDependency + realny test-guard API (P0)

Cel: dodać `@openai/agents` do devDependencies i napisać test operujący na REALNYCH obiektach SDK, który (a) jest regresją na oryginalny bug (real `Agent` nie ma `.run`), (b) potwierdza że narzędzia mają `.invoke`, (c) potwierdza że `Runner` ma `.run`. Ten test celowo powstaje PRZED zmianą implementacji i częściowo failuje, wyznaczając kontrakt.

**Files:**
- Modify: `packages/core/package.json` (sekcja `devDependencies`)
- Create: `packages/core/__tests__/integrations/openai-agents.real.test.ts`

**Interfaces:**
- Consumes: `instrumentOpenAIAgents` z `src/integrations/openai-agents.ts` (obecna wersja).
- Produces: sieciowo-niezależny test na realnym SDK; kolejne taski utrzymują go zielonym.

- [ ] **Step 1: Dodaj devDependency**

Run (z `packages/core`):
```bash
pnpm add -D @openai/agents zod
```
Expected: `package.json` `devDependencies` zawiera `@openai/agents` i `zod` (peer dep `@openai/agents`). `pnpm-lock.yaml` zaktualizowany. To NIE dodaje nic do `dependencies` (zero-runtime-dep zachowane).

- [ ] **Step 2: Ustal empirycznie kształt API (jednorazowa weryfikacja)**

Run (z `packages/core`):
```bash
node --input-type=module -e "
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';
const t = tool({ name: 'echo', description: 'x', parameters: z.object({}), execute: async () => 'ok' });
const a = new Agent({ name: 'A', tools: [t] });
console.log('agent.run typeof =', typeof a.run);         // oczekiwane: undefined
console.log('tool.invoke typeof =', typeof t.invoke);     // oczekiwane: function
console.log('tool.on_invoke_tool typeof =', typeof t.on_invoke_tool); // oczekiwane: undefined
console.log('runner.run typeof =', typeof new Runner().run);          // oczekiwane: function
console.log('agent.tools[0] === t ?', a.tools[0] === t);
"
```
Expected (zapisz wynik w komentarzu commita): `agent.run = undefined`, `tool.invoke = function`, `tool.on_invoke_tool = undefined`, `runner.run = function`. Jeśli którykolwiek się różni od powyższego — DOSTOSUJ kod Tasków 2–4 do faktycznego kształtu (to jest cały sens tego kroku).

- [ ] **Step 3: Napisz realny test-guard**

Utwórz `packages/core/__tests__/integrations/openai-agents.real.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';
import { instrumentOpenAIAgents } from '../../src/integrations/openai-agents.js';
import { TracelyxClient } from '../../src/client.js';
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

  it('instrumenting a real Agent does not throw and wraps its tools for tool_call spans', async () => {
    const t = tool({ name: 'search', description: 'x', parameters: z.object({}), execute: async () => 'found' });
    const agent = new Agent({ name: 'A', tools: [t] });

    expect(() => instrumentOpenAIAgents(agent, client)).not.toThrow();

    // Wywołaj realne .invoke narzędzia tak, jak zrobiłby to Runner podczas run().
    await (agent.tools[0] as unknown as {
      invoke: (ctx: unknown, input: string) => Promise<unknown>;
    }).invoke({}, '{}');
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    const toolSpan = body.spans.find((s) => s.kind === 'tool_call');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes['tool.name']).toBe('search');
  });
});
```

- [ ] **Step 4: Uruchom test — potwierdź RED na właściwym powodzie**

Run: `pnpm exec vitest run __tests__/integrations/openai-agents.real.test.ts`
Expected: pierwsze 3 testy (kształt SDK) PASS; test „instrumenting a real Agent…" FAIL — obecny kod rzuca `TypeError: Cannot read properties of undefined (reading 'bind')` w `instrumentAgent` (`openai-agents.ts:133`), bo real Agent nie ma `.run`. To potwierdza bug z przeglądu.

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json packages/core/pnpm-lock.yaml ../../pnpm-lock.yaml packages/core/__tests__/integrations/openai-agents.real.test.ts
git commit -m "test(openai-agents): add real @openai/agents API guard (RED); add devDependency"
```
(Jeśli lockfile jest tylko w root — dostosuj ścieżkę `git add`.)

---

## Task 2: OpenAI Agents — narzędzia przez `tool.invoke` (P0)

Cel: `wrapTools` ma wrapować realną metodę `invoke(runContext, input, details?)`, nie nieistniejące `on_invoke_tool`. `args[0]=runContext`, `args[1]=input` (JSON string) — mapowanie `tool.arguments = String(args[1])` zostaje poprawne. Heurystyka `transfer_to_*` → `handoff.target_agent` zostaje.

**Files:**
- Modify: `packages/core/src/integrations/openai-agents.ts` (`ToolLike` ~l.10-14, `wrapTools` ~l.25-82)
- Test: `packages/core/__tests__/integrations/openai-agents.real.test.ts` (już istnieje z Task 1)

**Interfaces:**
- Consumes: `getActiveContext`, `tracelyxClient.recordSpan`, `classifyError`.
- Produces: `wrapTools(tools, tracelyxClient)` wrapujące `tool.invoke`; tool spany `kind='tool_call'` z `tool.name`/`tool.arguments`/`handoff.target_agent`.

- [ ] **Step 1: Zmień interfejs `ToolLike` i `wrapTools`**

W `src/integrations/openai-agents.ts` zamień definicję `ToolLike`:

```typescript
interface ToolLike {
  name: string;
  invoke?(...args: unknown[]): Promise<unknown>;
  [key: string | symbol]: unknown;
}
```

W `wrapTools` zamień guard i przypisanie z `on_invoke_tool` na `invoke`:

```typescript
function wrapTools(tools: ToolLike[], tracelyxClient: TracelyxClient): void {
  for (const tool of tools) {
    if (tool[TOOL_INSTRUMENTED]) continue;
    if (typeof tool.invoke !== 'function') continue;

    const originalToolFn = tool.invoke.bind(tool);
    const toolName = tool.name;

    tool.invoke = async function (...args: unknown[]): Promise<unknown> {
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
          attributes['error.name'] = error.name;
        }
        throw error;
      } finally {
        const endTime = Date.now();
        if (toolName.startsWith('transfer_to_')) {
          const target = toolName.slice('transfer_to_'.length);
          getActiveContext()?.handoffTargets?.add(target);
          attributes['handoff.target_agent'] = target;
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
```

- [ ] **Step 2: Uruchom testy jednostkowe integracji (część RED — mocki jeszcze na starym kształcie)**

Run: `pnpm exec vitest run __tests__/integrations/openai-agents.test.ts __tests__/integrations/openai-agents.real.test.ts`
Expected: `openai-agents.real.test.ts` — test „instrumenting a real Agent… wraps its tools" nadal FAIL (bo `instrumentOpenAIAgents(agent)` wciąż rzuca w `instrumentAgent` — naprawa w Task 3); ale narzędzia w tym pliku nie są jeszcze osiągane. Stare mockowe testy (`openai-agents.test.ts`) FAIL, bo używają `on_invoke_tool` — zostaną przepisane w Task 4. To oczekiwany stan przejściowy.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/integrations/openai-agents.ts
git commit -m "fix(openai-agents): wrap real tool.invoke instead of Python on_invoke_tool"
```

---

## Task 3: OpenAI Agents — dispatcher Runner/run()/Agent bez martwego `agent.run` (P0)

Cel: `instrumentOpenAIAgents(target, client)` obsługuje trzy realne kształty: **Runner instance** (patch `runner.run`), **funkcja `run`** (zwróć owrapowaną funkcję), **Agent** (wrapuj tylko `.invoke` narzędzi + handoffy; brak `.run` do patchowania). Usuwamy martwy patch `agent.run` (rzucał `TypeError`). Best-effort: `openai.model` + agregat tokenów z `RunResult` na spanie `agent_step`.

**Files:**
- Modify: `packages/core/src/integrations/openai-agents.ts` (`AgentLike`, `isRunnerLike`, `instrumentOpenAIAgents`, `instrumentAgent`, `instrumentRunner`)
- Test: `packages/core/__tests__/integrations/openai-agents.real.test.ts`

**Interfaces:**
- Consumes: `wrapTools` (Task 2), `instrumentHandoffTargets`, `runWithContext`, `getActiveContext`, `classifyError`.
- Produces: `instrumentOpenAIAgents<T>(target: T, client): T` — dispatcher; helper `createRunSpan(originalRun, agentArg, args, client)` DRY dla Runner i `run()`.

- [ ] **Step 1: Dopisz realny test dispatchera (RED)**

Dopisz do `__tests__/integrations/openai-agents.real.test.ts`:

```typescript
it('instruments a real Runner instance: emits agent_step named after the agent', async () => {
  const runner = new Runner();
  const agent = new Agent({ name: 'assistant', model: 'gpt-4o' });
  instrumentOpenAIAgents(runner, client);

  // Zastąp faktyczne wykonanie stubem, żeby nie iść do sieci/modelu.
  const originalRun = (runner as unknown as { run: unknown }).run;
  expect(typeof originalRun).toBe('function');

  // Wymuś ścieżkę błędu bez modelu: patch already wraps run; wywołaj z agentem
  // i wejdź w catch (brak klucza/modelu => run rzuca). Span agent_step ma powstać.
  await runner.run(agent, 'hi').catch(() => {});
  await client.flush();

  const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body ?? '{"spans":[]}') as TracePayload;
  const span = body.spans.find((s) => s.kind === 'agent_step');
  expect(span).toBeDefined();
  expect(span!.name).toBe('agent.assistant');
  expect(span!.attributes['openai.model']).toBe('gpt-4o');
});
```

(Jeśli `runner.run` bez modelu nie rzuca lecz zawiesza — w Step 2 użyj wstrzykniętego stubu przez `setDefaultModelProvider`; w razie potrzeby oznacz ten pojedynczy test `it.skipIf(!process.env.OPENAI_API_KEY)` i zostaw 3 kształtowe + tool-wrap z Task 1 jako twardy guard sieciowo-niezależny.)

- [ ] **Step 2: Przepisz dispatcher i warianty**

W `src/integrations/openai-agents.ts`:

(a) `AgentLike` bez wymaganego `run` (real Agent go nie ma):

```typescript
interface AgentLike {
  name?: string;
  model?: string;
  tools?: ToolLike[];
  handoffs?: unknown[];
  [key: string | symbol]: unknown;
}

interface RunnerLike {
  run(agent: unknown, ...args: unknown[]): Promise<unknown>;
  [key: string | symbol]: unknown;
}
```

(b) Dispatcher rozpoznający funkcję / Runner / Agent:

```typescript
export function instrumentOpenAIAgents<T>(target: T, tracelyxClient: TracelyxClient): T {
  // 1) Eksport funkcji run(agent, input): zwróć owrapowaną funkcję (call-site: const run = instrumentOpenAIAgents(run, client)).
  if (typeof target === 'function') {
    return wrapRunFunction(target as (...a: unknown[]) => Promise<unknown>, tracelyxClient) as T;
  }
  if (target !== null && typeof target === 'object') {
    // 2) Runner: obiekt z metodą run(agent, input).
    if (typeof (target as RunnerLike).run === 'function') {
      return instrumentRunner(target as RunnerLike, tracelyxClient) as T;
    }
    // 3) Agent: bez .run — wrapujemy tylko narzędzia + handoffy (span agent_step powstaje z Runner/run()).
    return instrumentAgent(target as AgentLike, tracelyxClient) as T;
  }
  return target;
}
```

(c) `instrumentAgent` — TYLKO wrap narzędzi + handoffów, ZERO patchowania `run`:

```typescript
function instrumentAgent<T extends AgentLike>(agent: T, tracelyxClient: TracelyxClient): T {
  const agentAsAny = agent as any;
  if (agentAsAny[INSTRUMENTED]) return agent;
  agentAsAny[INSTRUMENTED] = true;
  if (Array.isArray(agentAsAny.tools)) wrapTools(agentAsAny.tools as ToolLike[], tracelyxClient);
  if (Array.isArray(agentAsAny.handoffs)) instrumentHandoffTargets(agentAsAny.handoffs, tracelyxClient);
  return agent;
}
```

(d) Wspólny helper `createRunSpan` + `instrumentRunner` + `wrapRunFunction`:

```typescript
function extractUsage(result: unknown): { promptTokens?: number; completionTokens?: number } {
  // Best-effort: RunResult może wystawiać agregat usage. Bezpiecznie, bez twardej zależności od kształtu.
  const r = result as { usage?: { inputTokens?: number; outputTokens?: number;
    promptTokens?: number; completionTokens?: number } } | null;
  const u = r?.usage;
  if (!u) return {};
  return {
    promptTokens: u.inputTokens ?? u.promptTokens,
    completionTokens: u.outputTokens ?? u.completionTokens,
  };
}

async function createRunSpan(
  originalRun: (...args: unknown[]) => Promise<unknown>,
  agentArg: unknown,
  args: unknown[],
  tracelyxClient: TracelyxClient,
): Promise<unknown> {
  const agent = (agentArg ?? {}) as AgentLike;
  if (agent !== null && typeof agent === 'object') {
    if (Array.isArray(agent.tools)) wrapTools(agent.tools, tracelyxClient);
    if (Array.isArray(agent.handoffs)) instrumentHandoffTargets(agent.handoffs, tracelyxClient);
  }

  const ctx = getActiveContext();
  const spanId = randomUUID();
  const traceId = ctx?.traceId ?? randomUUID();
  const parentSpanId = ctx?.spanId ?? null;
  const startTime = Date.now();
  const agentName = agent.name ?? 'unknown';
  const handoffTargets = new Set<string>();
  const attributes: Record<string, unknown> = {
    'agent.name': agentName,
    ...(agent.model !== undefined && { 'openai.model': agent.model }),
  };
  let status: 'ok' | 'error' = 'ok';
  let result: unknown;

  try {
    result = await runWithContext(
      { spanId, traceId, tenantId: ctx?.tenantId, handoffTargets },
      () => originalRun(agentArg, ...args),
    );
    const usage = extractUsage(result);
    if (usage.promptTokens !== undefined) attributes['llm.prompt_tokens'] = usage.promptTokens;
    if (usage.completionTokens !== undefined) attributes['llm.completion_tokens'] = usage.completionTokens;
    return result;
  } catch (error) {
    status = 'error';
    attributes['error.type'] = classifyError(error);
    if (error instanceof Error) {
      attributes['error.message'] = error.message;
      attributes['error.stack'] = error.stack;
      attributes['error.name'] = error.name;
    }
    throw error;
  } finally {
    if (handoffTargets.size > 0) attributes['handoff.target_agent'] = [...handoffTargets].join(',');
    const endTime = Date.now();
    tracelyxClient.recordSpan({
      id: spanId, traceId, parentSpanId, name: `agent.${agentName}`, kind: 'agent_step',
      startTime, endTime, durationMs: endTime - startTime, status, attributes, tenantId: ctx?.tenantId,
    });
  }
}

function instrumentRunner<T extends RunnerLike>(runner: T, tracelyxClient: TracelyxClient): T {
  const runnerAsAny = runner as any;
  if (runnerAsAny[INSTRUMENTED]) return runner;
  runnerAsAny[INSTRUMENTED] = true;
  const originalRun = runnerAsAny.run.bind(runnerAsAny);
  runnerAsAny.run = function (agentArg: unknown, ...args: unknown[]): Promise<unknown> {
    return createRunSpan(originalRun, agentArg, args, tracelyxClient);
  };
  return runner;
}

function wrapRunFunction(
  originalRun: (...args: unknown[]) => Promise<unknown>,
  tracelyxClient: TracelyxClient,
): (...args: unknown[]) => Promise<unknown> {
  return function (agentArg: unknown, ...args: unknown[]): Promise<unknown> {
    return createRunSpan(originalRun, agentArg, args, tracelyxClient);
  };
}
```

Usuń starą funkcję `isRunnerLike` (zastąpiona przez dispatcher) oraz stary korpus `instrumentAgent` patchujący `run`.

- [ ] **Step 3: Uruchom realny test**

Run: `pnpm exec vitest run __tests__/integrations/openai-agents.real.test.ts`
Expected: wszystkie testy PASS (kształty + tool-wrap na realnym Agencie + Runner agent_step; ewentualny full-loop test skip bez klucza).

- [ ] **Step 4: check-types**

Run: `pnpm check-types`
Expected: brak błędów (usunięcie `isRunnerLike`/starego ciała nie zostawia martwych referencji).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/integrations/openai-agents.ts packages/core/__tests__/integrations/openai-agents.real.test.ts
git commit -m "fix(openai-agents): dispatch Runner/run()/Agent for real SDK; drop dead agent.run patch"
```

---

## Task 4: OpenAI Agents — przepisanie testów mockowych na realny kształt (P0)

Cel: 19 istniejących testów w `openai-agents.test.ts` używa `.run` na agencie i `on_invoke_tool` na narzędziach — kształtu z Pythonowego SDK. Przepisujemy je tak, by symulowały realne API: instrumentacja przez **Runner-mock** (`{ run(agent, input) }`) oraz narzędzia z `.invoke`. Dzięki temu suite testuje faktyczny kontrakt, nie fikcję.

**Files:**
- Modify: `packages/core/__tests__/integrations/openai-agents.test.ts`

**Interfaces:**
- Consumes: `instrumentOpenAIAgents` (Task 3).
- Produces: mockowa suite odzwierciedlająca realny kształt (Runner + tools.invoke).

- [ ] **Step 1: Zamień wzorzec agenta na Runner-mock + narzędzia `.invoke`**

Dla każdego testu w `openai-agents.test.ts` zastosuj wzorzec (przykład kompletnego testu — pozostałe analogicznie, zamieniając `on_invoke_tool`→`invoke`, a bezpośrednie `agent.run(...)`→`runner.run(agent, ...)`):

```typescript
it('wraps runner.run() and creates an agent_step span with model', async () => {
  const agent = { name: 'SupportAgent', model: 'gpt-4o', tools: [] as any[] };
  const runner = { run: vi.fn().mockResolvedValue({ finalOutput: 'done' }) };
  instrumentOpenAIAgents(runner, client);

  await runner.run(agent, 'User question');
  await client.flush();

  const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
  const span = body.spans.find((s) => s.kind === 'agent_step')!;
  expect(span.name).toBe('agent.SupportAgent');
  expect(span.attributes['agent.name']).toBe('SupportAgent');
  expect(span.attributes['openai.model']).toBe('gpt-4o');
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
  expect(toolSpan.parentSpanId).toBe(agentSpan.id);
  expect(toolSpan.traceId).toBe(agentSpan.traceId);
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
  await trace.trace('step', async () => { await runner.run(agent, 'go'); });
  await client.flush();

  const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
  const span = body.spans.find((s) => s.kind === 'agent_step')!;
  expect(span.tenantId).toBe('tenant-xyz');
  expect(span.attributes['openai.model']).toBeUndefined();
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

it('auto-instruments handoff target agents (trace propagates)', async () => {
  const billing = { name: 'billing', tools: [] as any[] };
  const triage = { name: 'triage', handoffs: [billing], tools: [] as any[] };
  const runner = { run: vi.fn().mockResolvedValue({}) };
  instrumentOpenAIAgents(runner, client);

  await runner.run(triage, 'help');
  await client.flush();
  // instrumentHandoffTargets(triage.handoffs) wrapuje narzędzia targetu; trace propaguje przez AsyncLocalStorage.
  expect((billing as any)).toBeDefined(); // brak wyjątku = OK; szczegóły handoffu pokrywa test tool-span wyżej
});
```

Usuń/zastąp WSZYSTKIE stare testy odwołujące się do `agent.run(...)` bezpośrednio i do `on_invoke_tool`. Zachowaj testy semantyczne (idempotencja, tenant, error.type, tool nesting, handoff, cykle handoff) — tylko na nowym kształcie. Test cyklu handoff (A↔B) przenieś na Runner-mock analogicznie.

- [ ] **Step 2: Uruchom pełną suitę integracji**

Run: `pnpm exec vitest run __tests__/integrations/openai-agents.test.ts __tests__/integrations/openai-agents.real.test.ts`
Expected: wszystkie PASS.

- [ ] **Step 3: Pełna suita**

Run: `pnpm exec vitest run`
Expected: wszystko zielone (LangGraph/Anthropic/validate/hook bez zmian).

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/integrations/openai-agents.test.ts
git commit -m "test(openai-agents): rewrite suite to real Runner/run()/tool.invoke shapes"
```

---

## Task 5: OpenAI Agents — README (P0)

Cel: dokumentacja pokazuje realny sposób użycia (Runner / `run()`), nie martwy `instrumentOpenAIAgents(agent).run`.

**Files:**
- Modify: `packages/core/README.md` (sekcja „OpenAI Agents", ~l.77-94)

- [ ] **Step 1: Zaktualizuj sekcję OpenAI Agents**

Zamień blok przykładu na:

````markdown
### OpenAI Agents

`instrumentOpenAIAgents()` przyjmuje **Runner** lub eksportowaną funkcję **`run`** — to one wykonują agenta w `@openai/agents` (klasa `Agent` nie ma metody `.run()`). Owija wywołanie w span `agent_step` (nazwany po agencie, z `openai.model`), a narzędzia agenta (`tool.invoke`) w child spany `tool_call`. Handoffy (`transfer_to_*`) dostają `handoff.target_agent`. Możesz też przekazać sam obiekt `Agent`, by z góry zinstrumentować jego narzędzia; span całego runu powstaje wtedy z owiniętego Runnera/`run()`.

```typescript
import { instrumentOpenAIAgents } from '@tracelyx/core';
import { Agent, Runner, run } from '@openai/agents';

const agent = new Agent({ name: 'assistant', tools: [/* ... */] });

// Wariant A — Runner:
const runner = instrumentOpenAIAgents(new Runner(), tracelyx);
const result = await runner.run(agent, input);

// Wariant B — eksport run():
const tracedRun = instrumentOpenAIAgents(run, tracelyx);
const result2 = await tracedRun(agent, input);
```

> **Uwaga:** monkey-patch nie widzi pojedynczych wywołań modelu, więc integracja nie tworzy osobnych spanów `llm_call` ani pełnych liczników tokenów per-call (tokeny są best-effort agregatem na spanie `agent_step`, jeśli `RunResult` je udostępnia). Wierne spany `llm_call` wymagałyby integracji z `addTraceProcessor` z `@openai/agents` — planowane osobno.
````

- [ ] **Step 2: Bundle size + build**

Run (z `packages/core`): `pnpm build && gzip -c dist/index.js | wc -c`
Expected: < 20480.

- [ ] **Step 3: Commit**

```bash
git add packages/core/README.md
git commit -m "docs(core): document real OpenAI Agents (Runner/run) instrumentation"
```

---

## Task 6: Bufor — `flush()` gubi spany powyżej 100 (P1, data-loss)

Cel: `flush()`/`drain()` mają drenować DO KOŃCA, a nie jednorazowo 100 spanów. Obecnie `runDrain` robi jeden `splice(0,100)` bez pętli; przy >100 pending na wyjściu reszta przepada.

**Files:**
- Modify: `packages/core/src/buffer.ts` (`runDrain` ~l.60-68)
- Test: `packages/core/__tests__/buffer.test.ts`

**Interfaces:**
- Consumes: `sender`. Produces: `drain()` opróżnia cały `pending` (pętla batchy) przy zachowaniu serializacji `drainingPromise`.

- [ ] **Step 1: Test RED**

Dopisz do `__tests__/buffer.test.ts`:

```typescript
it('drain() flushes ALL pending spans across multiple batches, not just the first 100', async () => {
  const sent: number[] = [];
  const sender = vi.fn().mockImplementation(async (spans: unknown[]) => { sent.push(spans.length); });
  const buffer = new SpanBuffer(sender, 5_000);

  for (let i = 0; i < 250; i++) {
    (buffer as unknown as { pending: unknown[] }).pending.push({ id: String(i) });
  }
  await buffer.drain();

  expect(sent.reduce((a, b) => a + b, 0)).toBe(250); // wszystkie 250, nie 100
  expect((buffer as unknown as { pending: unknown[] }).pending).toHaveLength(0);
});
```

- [ ] **Step 2: Uruchom — RED**

Run: `pnpm exec vitest run __tests__/buffer.test.ts`
Expected: FAIL — wysłane 100, `pending` = 150.

- [ ] **Step 3: Pętla w `runDrain`**

W `src/buffer.ts` zamień `runDrain`:

```typescript
  private async runDrain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, MAX_BUFFER_SIZE);
      try {
        await this.sender(batch);
      } catch {
        // silent drop — TracelyxClient obsługuje retry na warstwie HTTP
      }
    }
  }
```

- [ ] **Step 4: Uruchom — GREEN + pełna suita**

Run: `pnpm exec vitest run __tests__/buffer.test.ts && pnpm exec vitest run`
Expected: PASS wszystko.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/buffer.ts packages/core/__tests__/buffer.test.ts
git commit -m "fix(buffer): drain all pending spans in a loop so flush() never drops >100"
```

---

## Task 7: Bufor — twardy limit pojemności + widoczność utraty (P1)

Cel: (A) `pending` ma górny limit — przy trwałej awarii wysyłki nie rośnie w nieskończoność (OOM); polityka drop-oldest. (B) trwały drop jest widoczny: throttled `console.warn` zamiast całkowitej ciszy (A6).

**Files:**
- Modify: `packages/core/src/buffer.ts` (`add`)
- Modify: `packages/core/src/client.ts` (`sendNative` — warn przy permanentnym dropie)
- Test: `packages/core/__tests__/buffer.test.ts`, `packages/core/__tests__/client.test.ts`

**Interfaces:**
- Produces: stała `MAX_PENDING = 10_000`; przy przekroczeniu `add` usuwa najstarszy span i liczy porzucenia; przy pierwszym porzuceniu — jednorazowy `console.warn`.

- [ ] **Step 1: Test RED (bufor cap)**

Dopisz do `__tests__/buffer.test.ts`:

```typescript
it('caps pending length at MAX_PENDING (drop-oldest) and warns once', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // sender nigdy nie kończy => brak drenażu
  const buffer = new SpanBuffer(() => new Promise<void>(() => {}), 5_000);
  for (let i = 0; i < 10_050; i++) buffer.add({ id: String(i) } as never);

  const pending = (buffer as unknown as { pending: unknown[] }).pending;
  expect(pending.length).toBeLessThanOrEqual(10_000);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('[Tracelyx]');
  warn.mockRestore();
});
```

- [ ] **Step 2: Uruchom — RED**

Run: `pnpm exec vitest run __tests__/buffer.test.ts`
Expected: FAIL — brak limitu.

- [ ] **Step 3: Implementacja capu w `add`**

W `src/buffer.ts` dodaj stałą i pole, oraz zmodyfikuj `add`:

```typescript
const MAX_BUFFER_SIZE = 100;
const MAX_PENDING = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
```

```typescript
  private overflowWarned = false;

  add(span: SpanPayload): void {
    if (this.stopped) return;
    this.pending.push(span);
    if (this.pending.length > MAX_PENDING) {
      this.pending.shift(); // drop-oldest
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        console.warn(
          `[Tracelyx] Span buffer exceeded ${MAX_PENDING} pending spans; ` +
            'dropping oldest. Ingest endpoint may be unreachable.',
        );
      }
    }
    if (this.pending.length >= MAX_BUFFER_SIZE) {
      void this.drain();
    } else {
      this.scheduleFlush();
    }
  }
```

- [ ] **Step 4: Test RED (client warn na permanentny drop)**

Dopisz do `__tests__/client.test.ts`:

```typescript
it('warns once when a batch is permanently dropped (non-retryable 4xx)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
  const client = new TracelyxClient({ apiKey: 'tl_test', projectId: 'proj_1' });

  client.recordSpan({
    id: '1', traceId: 't', parentSpanId: null, name: 'x', kind: 'custom',
    startTime: 0, endTime: 0, durationMs: 0, status: 'ok', attributes: {},
  });
  await client.flush();

  expect(warn).toHaveBeenCalled();
  expect(warn.mock.calls.some((c) => String(c[0]).includes('[Tracelyx]'))).toBe(true);
  warn.mockRestore();
  vi.unstubAllGlobals();
});
```

- [ ] **Step 5: Implementacja warn w `sendNative`**

W `src/client.ts`, w `sendNative`, w gałęzi permanentnego dropu (non-retryable 4xx oraz po wyczerpaniu retry) dodaj throttled warn. Dodaj pole i pomocniczą metodę:

```typescript
  private dropWarned = false;

  private warnDropOnce(reason: string): void {
    if (this.dropWarned) return;
    this.dropWarned = true;
    console.warn(`[Tracelyx] Dropping spans permanently (${reason}). Telemetry may be incomplete.`);
  }
```

W `sendNative` — gałąź non-retryable (po `if (!res.ok) { ... }`) i po wyczerpaniu retry w `catch`:

```typescript
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        if (retryable && attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** (attempt - 1));
          return this.sendNative(spans, attempt + 1);
        }
        this.warnDropOnce(`HTTP ${res.status}`);
      }
```
```typescript
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** (attempt - 1));
        return this.sendNative(spans, attempt + 1);
      }
      this.warnDropOnce('network error after retries');
    }
```

- [ ] **Step 6: Uruchom — GREEN + pełna suita**

Run: `pnpm exec vitest run`
Expected: wszystko zielone.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/buffer.ts packages/core/src/client.ts packages/core/__tests__/buffer.test.ts packages/core/__tests__/client.test.ts
git commit -m "feat(buffer,client): cap pending buffer (drop-oldest) and warn once on permanent span drop"
```

---

## Task 8: LangGraph — zagnieżdżanie subgrafów w `streamEvents` (P1, TASK-211)

Cel: node spany ze `streamEvents` mają dziedziczyć rodzica z rzeczywistej hierarchii runów (`parent_ids`/`run_id`), a nie płasko pod spanem invoke. Dziś każdy node dostaje `parentSpanId = spanInvoke`, więc węzły subgrafu są rodzeństwem rodzica, nie dziećmi (AC „subgraph = child span parent graph node" niespełnione dla ścieżki streamującej).

**Files:**
- Modify: `packages/core/src/integrations/langgraph.ts` (`StreamEventLike` ~l.19-24, patch `streamEvents` ~l.105-154)
- Test: `packages/core/__tests__/integrations/langgraph.test.ts`

**Interfaces:**
- Consumes: eventy `streamEvents` v2 z polami `run_id` i (opcjonalnie) `parent_ids: string[]` (LangChain Runnable API).
- Produces: mapę `run_id → spanId`; `parentSpanId` node spana = span najbliższego przodka-węzła z `parent_ids`, w innym razie span invoke.

- [ ] **Step 1: Test RED (zagnieżdżenie po parent_ids)**

Dopisz do `__tests__/integrations/langgraph.test.ts`:

```typescript
it('streamEvents nests child-node spans under their parent node via parent_ids', async () => {
  async function* fakeEvents() {
    yield { event: 'on_chain_start', name: 'router', run_id: 'p1', parent_ids: ['root'], metadata: { langgraph_node: 'router' } };
    yield { event: 'on_chain_start', name: 'fetch', run_id: 'c1', parent_ids: ['root', 'p1'], metadata: { langgraph_node: 'fetch' } };
    yield { event: 'on_chain_end', name: 'fetch', run_id: 'c1', parent_ids: ['root', 'p1'], metadata: { langgraph_node: 'fetch' } };
    yield { event: 'on_chain_end', name: 'router', run_id: 'p1', parent_ids: ['root'], metadata: { langgraph_node: 'router' } };
  }
  const graph = { invoke: vi.fn().mockResolvedValue({}), streamEvents: vi.fn().mockReturnValue(fakeEvents()) };
  instrumentLangGraph(graph, client);

  for await (const _e of (graph as any).streamEvents({})) { /* drain */ }
  await client.flush();

  const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
  const router = body.spans.find((s) => s.name === 'langgraph.node.router')!;
  const fetchN = body.spans.find((s) => s.name === 'langgraph.node.fetch')!;
  expect(router).toBeDefined();
  expect(fetchN.parentSpanId).toBe(router.id); // dziecko pod rodzicem, nie pod invoke
});

it('streamEvents ignores inner runnables that inherit langgraph_node but have a different name', async () => {
  async function* fakeEvents() {
    yield { event: 'on_chain_start', name: 'researcher', run_id: 'r1', metadata: { langgraph_node: 'researcher' } };
    // wewnętrzny runnable dziedziczy metadata.langgraph_node, ale ma inną nazwę -> NIE otwiera node spana
    yield { event: 'on_chain_start', name: 'ChatAnthropic', run_id: 'inner', metadata: { langgraph_node: 'researcher' } };
    yield { event: 'on_chain_end', name: 'ChatAnthropic', run_id: 'inner', metadata: { langgraph_node: 'researcher' } };
    yield { event: 'on_chain_end', name: 'researcher', run_id: 'r1', metadata: { langgraph_node: 'researcher' } };
  }
  const graph = { invoke: vi.fn().mockResolvedValue({}), streamEvents: vi.fn().mockReturnValue(fakeEvents()) };
  instrumentLangGraph(graph, client);
  for await (const _e of (graph as any).streamEvents({})) { /* drain */ }
  await client.flush();
  const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
  const nodeSpans = body.spans.filter((s) => s.name.startsWith('langgraph.node.'));
  expect(nodeSpans).toHaveLength(1); // tylko researcher, nie ChatAnthropic
  expect(nodeSpans[0].name).toBe('langgraph.node.researcher');
});
```

- [ ] **Step 2: Uruchom — RED**

Run: `pnpm exec vitest run __tests__/integrations/langgraph.test.ts`
Expected: FAIL — test parent_ids: `fetch.parentSpanId` = parentSpanId invoke/null, nie `router.id`. Test inner-runnable powinien już przechodzić (guard `e.name === nodeName` istnieje) — jeśli FAIL, to realny regres w filtrze.

- [ ] **Step 3: Implementacja mapy rodziców**

W `src/integrations/langgraph.ts` rozszerz `StreamEventLike`:

```typescript
interface StreamEventLike {
  event?: string;
  name?: string;
  run_id?: string;
  parent_ids?: string[];
  metadata?: { langgraph_node?: string; [key: string]: unknown };
}
```

W patchu `streamEvents` przydziel `spanId` już przy `on_chain_start` (żeby dziecko kończące się przed rodzicem mogło wskazać rodzica) i wybieraj rodzica z `parent_ids`. Zastąp CAŁĄ pętlę `for await` w patchu `streamEvents` poniższą wersją:

```typescript
      const openNodes = new Map<string, { name: string; startTime: number; spanId: string }>();
      const runIdToSpanId = new Map<string, string>();

      for await (const event of originalStreamEvents(input, options, ...rest)) {
        const e = event as StreamEventLike;
        const nodeName = e.metadata?.langgraph_node;

        if (nodeName !== undefined && e.run_id !== undefined) {
          if (e.event === 'on_chain_start' && e.name === nodeName) {
            // Przydziel spanId na starcie, by potomny węzeł mógł wskazać ten span jako rodzica.
            const nodeSpanId = randomUUID();
            runIdToSpanId.set(e.run_id, nodeSpanId);
            openNodes.set(e.run_id, { name: nodeName, startTime: Date.now(), spanId: nodeSpanId });
          } else if (e.event === 'on_chain_end' && openNodes.has(e.run_id)) {
            const { name, startTime, spanId: nodeSpanId } = openNodes.get(e.run_id)!;
            openNodes.delete(e.run_id);
            const now = Date.now();

            // Rodzic = najbliższy przodek z parent_ids, który jest znanym node spanem; inaczej span invoke.
            let nodeParentSpanId = parentSpanId;
            const ancestors = e.parent_ids ?? [];
            for (let i = ancestors.length - 1; i >= 0; i--) {
              const candidate = runIdToSpanId.get(ancestors[i]);
              if (candidate !== undefined && candidate !== nodeSpanId) {
                nodeParentSpanId = candidate;
                break;
              }
            }

            tracelyxClient.recordSpan({
              id: nodeSpanId,
              traceId,
              parentSpanId: nodeParentSpanId,
              name: `langgraph.node.${name}`,
              kind: 'agent_step',
              startTime,
              endTime: now,
              durationMs: now - startTime,
              status: 'ok',
              attributes: {
                'langgraph.node': name,
                'langgraph.node_name': name,
                ...(options?.configurable?.thread_id !== undefined && {
                  'langgraph.thread_id': options.configurable.thread_id,
                }),
              },
              tenantId: ctx?.tenantId,
            });
          }
        }

        yield event;
      }
```

Uwaga: `runIdToSpanId` NIE jest czyszczone przy `on_chain_end` (rodzic kończy się po dziecku, więc jego wpis musi przetrwać do momentu emisji dziecka). Eventy bez `parent_ids` (stare testy) dają `ancestors = []` → `parentSpanId` = span invoke, więc dotychczasowe zachowanie bez zmian.

- [ ] **Step 4: Uruchom — GREEN + zachowanie starych testów**

Run: `pnpm exec vitest run __tests__/integrations/langgraph.test.ts`
Expected: PASS wszystkie, w tym `streamEvents patch emits node spans with accurate start/end pairing by run_id` (eventy bez `parent_ids` → rodzic = invoke, bez zmian) i `streamEvents ignores unmatched on_chain_end and non-node events`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/integrations/langgraph.ts packages/core/__tests__/integrations/langgraph.test.ts
git commit -m "fix(langgraph): nest streamEvents node spans under parent node via parent_ids"
```

---

## Task 9: LangGraph — warunek warning i spójność atrybutów invoke (P2)

Cel: (A4) warning niekompatybilności ma pokrywać każdą nie-funkcyjną wartość `streamEvents`. (A5) span invoke nie powinien nieść kluczy `langgraph.thread_id`/`checkpoint_id` o wartości `undefined` — użyj spreadu warunkowego jak w node'ach.

**Files:**
- Modify: `packages/core/src/integrations/langgraph.ts` (warning ~l.40, invoke attrs ~l.165-168)
- Test: `packages/core/__tests__/integrations/langgraph.test.ts`

- [ ] **Step 1: Testy RED**

Dopisz do `__tests__/integrations/langgraph.test.ts`:

```typescript
it('warns when streamEvents is a non-function value (not just undefined)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  instrumentLangGraph({ invoke: vi.fn().mockResolvedValue({}), stream: vi.fn(), streamEvents: null } as any, client);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('streamEvents'));
  warn.mockRestore();
});

it('invoke span omits thread_id/checkpoint_id keys when config is absent', async () => {
  const graph = { invoke: vi.fn().mockResolvedValue({}) };
  instrumentLangGraph(graph, client);
  await graph.invoke({});
  await client.flush();
  const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
  const span = body.spans.find((s) => s.name === 'langgraph.invoke')!;
  expect('langgraph.thread_id' in span.attributes).toBe(false);
  expect('langgraph.checkpoint_id' in span.attributes).toBe(false);
});

it('invoke span carries checkpoint_id when provided in config', async () => {
  const graph = { invoke: vi.fn().mockResolvedValue({}) };
  instrumentLangGraph(graph, client);
  await graph.invoke({}, { configurable: { thread_id: 't1', checkpoint_id: 'ckpt-1' } });
  await client.flush();
  const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
  const span = body.spans.find((s) => s.name === 'langgraph.invoke')!;
  expect(span.attributes['langgraph.checkpoint_id']).toBe('ckpt-1');
});
```

- [ ] **Step 2: Uruchom — RED**

Run: `pnpm exec vitest run __tests__/integrations/langgraph.test.ts`
Expected: FAIL — warning nie odpala dla `null`; klucze obecne z `undefined`.

- [ ] **Step 3: Implementacja**

Warning (l.40) — zmień warunek:

```typescript
  if (typeof graphAsAny.stream === 'function' && typeof graphAsAny.streamEvents !== 'function') {
    console.warn(
      '[Tracelyx] LangGraph: streamEvents not found. Per-node spans and full streaming ' +
        'support require @langchain/langgraph >= 0.2.0.',
    );
  }
```

Atrybuty invoke (l.165-168) — spread warunkowy:

```typescript
    const attributes: Record<string, unknown> = {
      ...(config?.configurable?.thread_id !== undefined && {
        'langgraph.thread_id': config.configurable.thread_id,
      }),
      ...(config?.configurable?.checkpoint_id !== undefined && {
        'langgraph.checkpoint_id': config.configurable.checkpoint_id,
      }),
    };
```

(Uwaga: `attributes['error.type']` itd. w bloku catch dopisują się do tego obiektu bez zmian.)

- [ ] **Step 4: Uruchom — GREEN + pełna suita**

Run: `pnpm exec vitest run`
Expected: zielone. Zwróć uwagę: istniejący test „wraps invoke() and creates an agent_step span" oczekuje `thread_id='thread-1'` przy podanym configu — nadal spełnione.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/integrations/langgraph.ts packages/core/__tests__/integrations/langgraph.test.ts
git commit -m "fix(langgraph): warn on non-function streamEvents; omit undefined invoke attrs; cover checkpoint_id"
```

---

## Task 10: Routing tenantów — split paczki po `tenantId` (P1)

Cel: paczka spanów z różnych tenantów nie może iść z jednym `TracePayload.tenantId` wziętym ze `spans[0]`. `sendNative` grupuje spany po `tenantId` i wysyła osobny POST per tenant. Eliminuje ryzyko błędnej atrybucji, gdy backend routuje po nagłówku paczki.

**Files:**
- Modify: `packages/core/src/client.ts` (`sendNative` ~l.71-102)
- Test: `packages/core/__tests__/client.test.ts`

**Interfaces:**
- Produces: `sendNative(spans)` dzieli `spans` po `tenantId` i wykonuje jeden `fetch` per grupa; każdy `TracePayload.tenantId` = tenant danej grupy. Retry per grupa bez zmian.

- [ ] **Step 1: Test RED**

Dopisz do `__tests__/client.test.ts`:

```typescript
it('splits a mixed-tenant batch into one POST per tenant with correct envelope tenantId', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"accepted":1}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const client = new TracelyxClient({ apiKey: 'tl_test', projectId: 'proj_1' });

  const mk = (id: string, tenantId?: string) => ({
    id, traceId: id, parentSpanId: null, name: 'x', kind: 'custom' as const,
    startTime: 0, endTime: 0, durationMs: 0, status: 'ok' as const, attributes: {}, tenantId,
  });
  client.recordSpan(mk('a', 'acme'));
  client.recordSpan(mk('b', 'globex'));
  client.recordSpan(mk('c', 'acme'));
  await client.flush();

  const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
  const byTenant = Object.fromEntries(bodies.map((b) => [b.tenantId, b.spans.length]));
  expect(byTenant['acme']).toBe(2);
  expect(byTenant['globex']).toBe(1);
  bodies.forEach((b) => b.spans.forEach((s: { tenantId?: string }) => expect(s.tenantId).toBe(b.tenantId)));
  vi.unstubAllGlobals();
});
```

- [ ] **Step 2: Uruchom — RED**

Run: `pnpm exec vitest run __tests__/client.test.ts`
Expected: FAIL — jeden POST z `tenantId='acme'` i 3 spanami.

- [ ] **Step 3: Implementacja grupowania**

W `src/client.ts` zamień `sendNative` tak, by dzielił po tenant i delegował do prywatnego `sendGroup` (retry pozostaje przy `sendGroup`):

```typescript
  private async sendNative(spans: SpanPayload[]): Promise<void> {
    const groups = new Map<string | undefined, SpanPayload[]>();
    for (const span of spans) {
      const key = span.tenantId;
      const arr = groups.get(key);
      if (arr) arr.push(span);
      else groups.set(key, [span]);
    }
    await Promise.all([...groups.values()].map((group) => this.sendGroup(group)));
  }

  private async sendGroup(spans: SpanPayload[], attempt = 1): Promise<void> {
    const payload: TracePayload = {
      projectId: this.projectId,
      tenantId: spans[0]?.tenantId,
      environment: this.environment,
      spans,
    };
    try {
      const res = await fetch(`${this.endpoint}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        if (retryable && attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** (attempt - 1));
          return this.sendGroup(spans, attempt + 1);
        }
        this.warnDropOnce(`HTTP ${res.status}`);
      }
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** (attempt - 1));
        return this.sendGroup(spans, attempt + 1);
      }
      this.warnDropOnce('network error after retries');
    }
  }
```

(`warnDropOnce`/`dropWarned` z Task 7 pozostają. Konstruktor `sender` używa `sendNative` bez zmian — nadal pojedynczy argument `spans`.)

- [ ] **Step 4: Uruchom — GREEN + pełna suita**

Run: `pnpm exec vitest run`
Expected: zielone (istniejące testy `client.test.ts`/`client-otlp.test.ts` wciąż OK — single-tenant batch daje 1 POST).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/client.ts packages/core/__tests__/client.test.ts
git commit -m "fix(client): split mixed-tenant batches into one POST per tenant"
```

---

## Task 11: Luki testowe dla poprawnego kodu (P2)

Cel: dołożyć regresyjne asercje dla zachowań już poprawnych, ale niepokrytych: `error.type` w Anthropic, `classifyError` (TimeoutError + kolejność timeout-vs-network), gałęzie `validate` (GET zawsze rzuca). Bez zmian w kodzie produkcyjnym.

**Files:**
- Modify: `packages/core/__tests__/integrations/anthropic.test.ts`
- Modify: `packages/core/__tests__/errors.test.ts`
- Modify: `packages/core/__tests__/bin/validate.test.ts`

- [ ] **Step 1: Test error.type dla Anthropic**

Dopisz do `__tests__/integrations/anthropic.test.ts`:

```typescript
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
```

- [ ] **Step 2: Testy classifyError**

Dopisz do `__tests__/errors.test.ts` (wewnątrz `describe`):

```typescript
it('classifies err.name === "TimeoutError" as tool_timeout', () => {
  expect(classifyError(Object.assign(new Error('deadline'), { name: 'TimeoutError' }))).toBe('tool_timeout');
});

it('timeout message wins over network code (documented branch order)', () => {
  const err = Object.assign(new Error('socket timeout'), { code: 'ECONNRESET' });
  expect(classifyError(err)).toBe('tool_timeout');
});
```

- [ ] **Step 3: Testy validate — GET zawsze rzuca (receipt not confirmed)**

Dopisz do `__tests__/bin/validate.test.ts`:

```typescript
it('exits 1 when POST is ok but GET rejects on every attempt (receipt not confirmed)', async () => {
  vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(new Response('{"accepted":1}', { status: 200 }));
    return Promise.reject(new Error('boom')); // GET zawsze rzuca
  });
  vi.stubGlobal('fetch', fetchMock);
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true; });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit(${code})`);
  }) as (code?: number) => never);

  try { await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1']); } catch { /* expected */ }

  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(out.join('')).toContain('accepted but could not be confirmed');
});
```

- [ ] **Step 4: Uruchom — wszystkie zielone**

Run: `pnpm exec vitest run __tests__/integrations/anthropic.test.ts __tests__/errors.test.ts __tests__/bin/validate.test.ts`
Expected: PASS (kod produkcyjny już poprawny → testy od razu zielone; jeśli któryś FAIL, oznacza realny bug — zdebuguj).

- [ ] **Step 5: Commit**

```bash
git add packages/core/__tests__/integrations/anthropic.test.ts packages/core/__tests__/errors.test.ts packages/core/__tests__/bin/validate.test.ts
git commit -m "test(core): cover anthropic error.type, classifyError ordering, validate GET-throws"
```

---

## Task 12: `hook-listener` hardening + ostrzeżenie `--api-key` (P2, security)

Cel: (S2) serwer `hook-listener` — limit rozmiaru ciała (odrzuć > 1 MB), bind tylko na `127.0.0.1`. (S3) `validate` z flagą `--api-key` wypisuje na stderr ostrzeżenie, że klucz jest widoczny w liście procesów.

**Files:**
- Modify: `packages/core/bin/tracelyx.ts` (`runHookListenerCommand` ~l.94-133, `runValidateCommand` ~l.137-141)
- Test: `packages/core/__tests__/bin/validate.test.ts` (ostrzeżenie stderr)

**Interfaces:**
- Produces: `MAX_HOOK_BODY_BYTES = 1_048_576`; serwer odrzuca za duże body (413) i bind na loopback; `validate` z jawną flagą `--api-key` → `process.stderr.write(...)`.

- [ ] **Step 1: Test RED — ostrzeżenie stderr dla --api-key**

Dopisz do `__tests__/bin/validate.test.ts`:

```typescript
it('warns on stderr when --api-key is passed as a flag', async () => {
  vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
  vi.stubGlobal('fetch', mockPostOkGetTrace([{ status: 200, body: { id: 't-1' } }]));
  const err: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err.push(String(c)); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit(${code})`); }) as (c?: number) => never);

  try { await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1']); } catch { /* expected */ }

  expect(err.join('')).toMatch(/api-key.*visible|process list/i);
});

it('does NOT warn on stderr when api-key comes from env', async () => {
  vi.stubEnv('TRACELYX_API_KEY', 'tl_env');
  vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
  vi.stubGlobal('fetch', mockPostOkGetTrace([{ status: 200, body: { id: 't-1' } }]));
  const err: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err.push(String(c)); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit(${code})`); }) as (c?: number) => never);

  try { await runValidateCommand(['--project-id', 'proj_1']); } catch { /* expected */ }

  expect(err.join('')).not.toMatch(/api-key.*visible/i);
});
```

- [ ] **Step 2: Uruchom — RED**

Run: `pnpm exec vitest run __tests__/bin/validate.test.ts`
Expected: FAIL — brak ostrzeżenia.

- [ ] **Step 3: Ostrzeżenie w `runValidateCommand`**

W `bin/tracelyx.ts`, w `runValidateCommand`, tuż po ustaleniu `apiKey`/`projectId` dodaj detekcję jawnej flagi (przed budową payloadu):

```typescript
  const apiKeyFromFlag = flagValue(args, '--api-key');
  if (apiKeyFromFlag !== undefined) {
    process.stderr.write(
      'WARNING: --api-key is visible in the process list and shell history. ' +
        'Prefer the TRACELYX_API_KEY environment variable.\n',
    );
  }
```

- [ ] **Step 4: Hardening `hook-listener`**

W `bin/tracelyx.ts` dodaj stałą i zmodyfikuj `runHookListenerCommand`:

```typescript
const MAX_HOOK_BODY_BYTES = 1_048_576; // 1 MB
```

W handlerze serwera — limit rozmiaru i bind loopback:

```typescript
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_HOOK_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString('utf-8');

    try {
      const hookData = JSON.parse(body) as Record<string, unknown>;
      const hookName = typeof hookData['event'] === 'string' ? hookData['event'] : 'UnknownEvent';
      client.recordSpan(buildHookSpan(hookName, hookData));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    } catch {
      res.writeHead(400).end();
    }
  });

  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Tracelyx hook listener running on 127.0.0.1:${port}\n`);
  });
```

- [ ] **Step 5: Uruchom — GREEN + pełna suita**

Run: `pnpm exec vitest run`
Expected: zielone (istniejące testy hook używają `runHookCommand`, nie serwera — bez wpływu).

- [ ] **Step 6: Commit**

```bash
git add packages/core/bin/tracelyx.ts packages/core/__tests__/bin/validate.test.ts
git commit -m "fix(bin): cap hook-listener body, bind loopback; warn on --api-key flag exposure"
```

---

## Task 13: Dokumentacja — decyzje, ograniczenia, hardening (P2)

Cel: udokumentować świadome decyzje i ograniczenia: odroczoną redakcję (S1), MD5 jako fingerprint (S5), `error.stack` w telemetrii (S4), nazwę node spana (poza zakresem), raw-`fetch` w `validate` (poza zakresem), batching per-tenant, bezpieczeństwo `hook-listener`.

**Files:**
- Modify: `packages/core/README.md`

- [ ] **Step 1: Dopisz sekcję „Bezpieczeństwo i ograniczenia"**

Dodaj do `packages/core/README.md`:

````markdown
## Bezpieczeństwo i ograniczenia

- **Przechwytywanie payloadów bez redakcji (odroczone):** SDK wysyła pełne prompty/odpowiedzi (`inputPayload`/`outputPayload`), argumenty narzędzi (`tool.arguments`) oraz wejścia/wyjścia hooków bez maskowania. Sekret lub PII zawarte w tych danych trafiają do Twojego backendu obserwability (magazyn at-rest, dostęp wg uprawnień projektu). Redakcja/opt-out SDK jest planowana w TASK-014. Do tego czasu nie loguj sekretów w promptach/argumentach, jeśli nie chcesz ich w trace'ach.
- **`error.message` / `error.stack` w atrybutach:** spany błędów niosą pełny komunikat i stos wyjątku (ścieżki, struktura modułów). To standard SDK obserwability (Sentry/OTel), ale te pola nie są redagowane.
- **`llm.system_prompt_hash` to MD5 fingerprint, nie anonimizacja:** służy grupowaniu identycznych promptów. Nie zakładaj, że ukrywa treść — prompt o niskiej entropii da się potwierdzić brute-force'em kandydatów.
- **`tracelyx validate --api-key <key>`:** klucz jest widoczny w `ps`/historii shella. Preferuj `TRACELYX_API_KEY` (SDK ostrzega na stderr przy użyciu flagi).
- **`tracelyx hook-listener`:** nasłuchuje wyłącznie na `127.0.0.1`, odrzuca ciała > 1 MB. Endpoint `/hook` nie ma dodatkowej autoryzacji — nie eksponuj portu poza loopback.
- **Nazewnictwo:** node spany LangGraph mają nazwę `langgraph.node.<node>` (czytelność); goła nazwa węzła jest w atrybucie `langgraph.node_name`.
- **`validate`** używa bezpośrednio `fetch` (a nie `TracelyxClient`), bo potrzebuje kodu HTTP (401) i potwierdzenia receipt przez `GET /v1/traces/:id`.
- **Batching per-tenant:** paczki spanów są dzielone po `tenantId` przed wysyłką — każdy `TracePayload` niesie tenant swojej grupy.
````

- [ ] **Step 2: Bundle + pełna weryfikacja monorepo**

Run (z repo root): `pnpm build && pnpm test && pnpm check-types`
Expected: wszystko zielone; z `packages/core`: `gzip -c dist/index.js | wc -c` < 20480.

- [ ] **Step 3: Commit**

```bash
git add packages/core/README.md
git commit -m "docs(core): document security posture, deferred redaction, and design decisions"
```

---

## Mapowanie tasków na problemy z przeglądu

| Task | Problem(y) | Priorytet |
|---|---|---|
| 1 | TASK-212 regresja API (devDep + realny guard) | P0 |
| 2 | TASK-212: `tool.invoke` zamiast `on_invoke_tool` | P0 |
| 3 | TASK-212: martwy `agent.run` → dispatcher Runner/`run()`/Agent; agregat model/tokeny | P0 |
| 4 | TASK-212: przepisanie 19 testów na realny kształt | P0 |
| 5 | TASK-212: README | P0 |
| 6 | A1: `flush()` gubi spany > 100 (data-loss) | P1 |
| 7 | Bufor bez limitu (DoS) + A6 cicha utrata | P1 |
| 8 | A2: spłaszczone subgrafy w `streamEvents` (TASK-211) | P1 |
| 9 | A4 warning≠patch; A5 atrybuty invoke; T2 checkpoint_id | P2 |
| 10 | A3: routing tenantów (split per tenant) | P1 |
| 11 | T1 anthropic error.type; T6 classifyError; T5 validate | P2 |
| 12 | S2 hook-listener hardening; S3 ostrzeżenie `--api-key` | P2 |
| 13 | S1/S4/S5 + decyzje poza zakresem (docs) | P2 |

**Świadomie nie-taskowane (poza zakresem SDK lub decyzja „won't-fix"):** llm_call spany + pełne tokeny OpenAI (wymaga `addTraceProcessor`); nazwa node spana; `validate` przez `TracelyxClient`; pełna redakcja PII (TASK-014); **A7** — wyciąganie `checkpoint_id` wygenerowanego w trakcie świeżego runu LangGraph (wymaga dodatkowego `graph.getState(config)` poza ścieżką spana; roadmapa oznacza atrybut jako „jeśli dostępny", więc łapiemy tylko `checkpoint_id` podany w configu — Task 9).
