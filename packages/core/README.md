# @tracelyx/core

Minimal observability SDK for AI agents. Zero dependencies, < 20KB gzip.

## Install

```bash
npm install @tracelyx/core
```

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

Spans with status `error` automatically receive an `attributes['error.type']` field. The SDK classifies exceptions into: `tool_timeout`, `context_window_exceeded`, `json_parse_error`, `rate_limit`, `network_error`, `hook_error`, or `unknown`. The `classifyError()` function is exported publicly for custom error handling.

```typescript
import { classifyError } from '@tracelyx/core';

try {
  // ...
} catch (err) {
  const errorType = classifyError(err);
  console.log(errorType); // 'rate_limit', 'tool_timeout', etc.
}
```

### LangGraph

LangGraph integration instruments both `stream()` and `streamEvents()` calls, creating per-node spans. `streamEvents()` gives accurate per-node start/end times (from `on_chain_start`/`on_chain_end` events; requires `@langchain/langgraph >= 0.2.0`), while `stream()` approximates node duration as the time between successive chunks.

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

`instrumentOpenAIAgents()` accepts either an agent or a runner. Multi-agent runs with handoffs automatically propagate a single trace across all agents — all spans share the same `traceId`. Handoff detection records `handoff.target_agent` on the `transfer_to_*` tool span; when instrumenting an agent directly, the agent's own span also aggregates the handoff targets.

```typescript
import { instrumentOpenAIAgents } from '@tracelyx/core';
import { Agent, Runner } from '@openai/agents';

const agent = new Agent(...);
instrumentOpenAIAgents(agent, tracelyx);

// or with a runner (wraps the run in an agent_step span and instruments
// the passed agent's tools/handoffs):
const runner = new Runner();
instrumentOpenAIAgents(runner, tracelyx);
const result = await runner.run(agent, input);
// Spans are still created with the same traceId across all agents
```

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
