# @tracelyx/core

Minimal observability SDK for AI agents. Zero dependencies, < 20KB gzip.

## Quickstart

```typescript
import { TracelyxClient, instrumentAnthropic } from '@tracelyx/core';
import Anthropic from '@anthropic-ai/sdk';

const tracelyx = new TracelyxClient({ apiKey: 'tl_...', projectId: 'my-project' });
const anthropic = new Anthropic();
instrumentAnthropic(anthropic, tracelyx);

// All anthropic.messages.create() calls are now traced automatically
```

## Manual tracing

```typescript
const trace = tracelyx.startTrace({ name: 'process-request', tenantId: 'acme-corp' });

const result = await trace.trace('fetch-context', async () => {
  return fetchUserContext(userId);
});

await tracelyx.flush(); // call once at process exit
```

## Integrations

| Function | Library |
|---|---|
| `instrumentAnthropic(client, tracelyx)` | `@anthropic-ai/sdk` |
| `instrumentLangGraph(graph, tracelyx)` | `@langchain/langgraph` |
| `instrumentOpenAIAgents(agent, tracelyx)` | `@openai/agents` |

### Error classification

Spans with status `error` automatically receive an `attributes['error.type']` field. The SDK classifies exceptions into: `tool_timeout`, `context_window_exceeded`, `json_parse_error`, `rate_limit`, `network_error`, `hook_error`, or `unknown`. The raw exception class is also preserved in `attributes['error.name']` (e.g. `TypeError`, `AbortError`) — useful when the classifier collapses to `unknown`. The `classifyError()` function is exported publicly for custom error handling.

```typescript
import { classifyError } from '@tracelyx/core';

try {
  // ...
} catch (err) {
  const errorType = classifyError(err);
  console.log(errorType); // 'rate_limit', 'tool_timeout', etc.
}
```

### Anthropic

#### Streaming

Streaming calls are traced automatically — both `messages.create({ stream: true })`
and `messages.stream(...)` (which funnels through `create`). The `llm_call` span is
recorded when the stream **completes**, so `durationMs` covers the full generation and
`promptTokens` / `completionTokens` / `outputPayload` are populated from the streamed
events. If the consumer breaks early or the stream errors, the span is still recorded
with `attributes['llm.stream_incomplete'] = true`.

> Limitation: a consumer that reads the stream **only** via `stream.tee()` or
> `stream.toReadableStream()` (never `for await`) is not traced.

### LangGraph

LangGraph integration instruments both `stream()` and `streamEvents()` calls, creating per-node spans. `streamEvents()` gives accurate per-node start/end times (from `on_chain_start`/`on_chain_end` events; requires `@langchain/langgraph >= 0.2.0`). The `stream()` path derives one span per node from update chunks and approximates node duration as the time between successive chunks — it requires `streamMode: 'updates'` (under the default `'values'` mode a chunk is the full state keyed by channels, not nodes, so no node spans are emitted). For per-node timing regardless of mode, prefer `streamEvents()`.

Emitted attributes:
- `langgraph.node_name` — the executed node
- `langgraph.thread_id` — conversation thread ID
- `langgraph.checkpoint_id` — checkpoint for replays

Subgraphs nest automatically: when an instrumented subgraph's `invoke()` runs inside an instrumented parent graph's `invoke()`, the subgraph's span becomes a child of the parent's span (same trace, parent/child linked via `AsyncLocalStorage`). Per-node spans come separately from `stream()`/`streamEvents()`.

```typescript
import { instrumentLangGraph } from '@tracelyx/core';

const graph = new StateGraph(...);
const app = graph.compile();
instrumentLangGraph(app, tracelyx);

// Both stream() and streamEvents() are instrumented
for await (const event of app.streamEvents(input, { version: 'v2' })) {
  // Per-node spans are created from on_chain_start/on_chain_end event pairs
}
```

### OpenAI Agents

`instrumentOpenAIAgents()` accepts a **Runner** or the exported **`run`** function — these execute an agent in `@openai/agents` (the `Agent` class has no `.run()` method). It wraps the call in an `agent_step` span (named after the agent, with `openai.model`) and wraps the agent's tools (`tool.invoke`) in child `tool_call` spans. You can also pass an `Agent` object to instrument its tools and handoffs ahead of time; the span for the whole run then comes from the wrapped Runner/`run()`.

`handoff.target_agent` is captured for handoffs declared as a `Handoff` instance — i.e. `handoff(agent)` placed in the agent's `handoffs` array (`new Agent({ handoffs: [handoff(billing)] })`). When such a handoff fires it emits a `handoff.<target>` span and is aggregated onto the run's `agent_step` span. (If you hand-place a `transfer_to_*` function tool in `agent.tools` yourself, that tool's invocation is captured the same way — but that is not how `@openai/agents` normally routes handoffs.) The bare `handoffs: [agent]` shorthand (where the SDK builds the `Handoff` internally at run time) and the full per-agent multi-agent topology are **not** captured by this zero-dependency monkey-patch; use `@openai/agents`' `addTraceProcessor` for those (the same path used below for faithful `llm_call` spans).

```typescript
import { instrumentOpenAIAgents } from '@tracelyx/core';
import { Agent, Runner, run } from '@openai/agents';

const agent = new Agent({ name: 'assistant', tools: [/* ... */] });

// Option A — Runner:
const runner = instrumentOpenAIAgents(new Runner(), tracelyx);
const result = await runner.run(agent, input);

// Option B — the exported run():
const tracedRun = instrumentOpenAIAgents(run, tracelyx);
const result2 = await tracedRun(agent, input);
```

Per-model-call `llm_call` spans (carrying `openai.model`, top-level `llmModel`, and
prompt/completion token counts) are available **opt-in**: pass `@openai/agents`'
`addTraceProcessor` as `{ tracing }`. It is **injected**, so `@tracelyx/core` never
imports `@openai/agents` and stays zero-dependency:

```ts
import { addTraceProcessor } from '@openai/agents';
import { instrumentOpenAIAgents } from '@tracelyx/core';

instrumentOpenAIAgents(runner, tracelyx, { tracing: addTraceProcessor });
```

> **Cost aggregation note:** with `{ tracing }`, tokens appear on **two** spans per run — the `agent_step` (a run-level rollup summed across all model calls) and each per-call `llm_call`. Their token totals overlap, so a consumer must **not** sum both: aggregate `llm_call` spans for per-call cost, and use the `agent_step` rollup only for runs with no child `llm_call` spans (e.g. when tracing is off). The native ingest format preserves `span.kind` for exactly this dedup.

The processor is registered once per client and emits an `llm_call` span per model
call, nested under the run's `agent_step` when it fires inside the run. Without
`{ tracing }`, behavior is unchanged (agent/tool spans only, with best-effort aggregate
tokens on the `agent_step` span). Requires `@openai/agents` tracing enabled (the default).

## CLI

```bash
# Verify configuration and confirm receipt
npx tracelyx validate --api-key tl_xxx --project-id my-project

# Verify with tenant routing check
npx tracelyx validate --api-key tl_xxx --project-id my-project --tenant acme-corp

# Claude Code hooks listener
TRACELYX_API_KEY=tl_xxx TRACELYX_PROJECT_ID=my-project npx tracelyx hook-listener
```

The `validate` command confirms successful trace receipt via `GET /v1/traces/:id`. With `--tenant`, it also verifies that the trace routed to the correct tenant.

Claude Code `.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tracelyx hook --event PreToolUse" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tracelyx hook --event PostToolUse" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "tracelyx hook --event Stop" }] }]
  }
}
```

## Security & limitations

- **Payload capture without redaction (deferred):** the SDK sends full prompts/responses (`inputPayload`/`outputPayload`), tool arguments (`tool.arguments`), and hook inputs/outputs without masking. Secrets or PII contained in that data reach your observability backend (at-rest storage, access controlled by project permissions). SDK-side redaction/opt-out is planned in TASK-014. Until then, avoid putting secrets in prompts or tool arguments if you don't want them in traces.
- **`error.message` / `error.stack` in attributes:** error spans carry the full exception message and stack trace (file paths, module structure). This is standard for observability SDKs (Sentry/OpenTelemetry), but these fields are not redacted.
- **`llm.system_prompt_hash` is an MD5 fingerprint, not anonymization:** it groups identical system prompts. Do not assume it hides the content — a low-entropy prompt can be confirmed by brute-forcing candidate hashes.
- **`tracelyx validate --api-key <key>`:** the key is visible in `ps` / shell history. Prefer the `TRACELYX_API_KEY` environment variable (the CLI warns on stderr when the flag is used).
- **`tracelyx hook-listener`:** listens only on `127.0.0.1` and rejects request bodies larger than 1 MB. The `/hook` endpoint has no additional authorization — do not expose the port beyond loopback.
- **Naming:** LangGraph node spans are named `langgraph.node.<node>` (readability); the bare node name is in the `langgraph.node_name` attribute.
- **`validate`** uses `fetch` directly (not `TracelyxClient`) because it needs the HTTP status code (401) and receipt confirmation via `GET /v1/traces/:id`.
- **Per-tenant batching:** span batches are split by `tenantId` before sending — each `TracePayload` carries its group's tenant.
