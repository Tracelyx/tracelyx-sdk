# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# From repo root (Turborepo orchestrates all packages)
pnpm install          # install all dependencies
pnpm build            # build all packages
pnpm test             # run all tests
pnpm check-types      # TypeScript type-check all packages

# From packages/core
pnpm test             # vitest run (single pass)
pnpm test:watch       # vitest in watch mode
pnpm build            # tsup (outputs dist/)
pnpm check-types      # tsc --noEmit

# Run a single test file
cd packages/core && pnpm exec vitest run __tests__/tracer.test.ts
```

## Architecture

This is a **pnpm + Turborepo monorepo**. Currently one published package: `@tracelyx/core` (`packages/core`). The package ships both ESM and CJS via tsup with dual entry points (`dist/index.js` / `dist/index.cjs`). It also bundles a CLI binary (`dist/bin/tracelyx.js`, exposed as the `tracelyx` command).

### Core data flow

```
TracelyxClient → Trace → Span → SpanBuffer → HTTP POST /v1/traces
```

- **`TracelyxClient`** (`src/client.ts`): top-level entry point. Holds `apiKey`, `projectId`, `endpoint`. Creates `Trace` objects via `startTrace()`. Calls `flush()` at process exit to drain pending spans (10 s timeout).
- **`SpanBuffer`** (`src/buffer.ts`): batches spans in memory; auto-flushes every 5 s or when 100 spans accumulate. Uses `.unref()` on the timer so the buffer never keeps the process alive. Serialises concurrent `drain()` calls.
- **`Trace` / `Span`** (`src/tracer.ts`): `Trace` owns a `traceId` and passes spans up via an `onSpan` callback. `Span` collects attributes and emits a `SpanPayload` on `.end()`. Parent–child relationships are tracked via `AsyncLocalStorage<{ spanId, traceId }>` — `trace.trace()` wraps async work in a new storage context so nested spans automatically pick up `parentSpanId`.
- **`SpanPayload`** / **`TracePayload`** (`src/types.ts`): the wire format. `SpanPayload` carries timing, status, `SpanKind`, and optional LLM-specific fields (`promptTokens`, `completionTokens`, `inputPayload`, `outputPayload`, `stateSnapshot`).

### Integrations (`src/integrations/`)

Each integration monkey-patches a third-party object and calls `tracelyxClient.recordSpan()` directly (bypassing `Trace`). All use an `INSTRUMENTED` Symbol guard to prevent double-patching.

- **`instrumentAnthropic`**: wraps `client.messages.create`; records an `llm_call` span with token counts, model, system-prompt MD5 hash, and raw message payloads.
- **`instrumentOpenAIAgents`**: wraps `agent.run` (→ `agent_step` span) and each `tool.on_invoke_tool` (→ `tool_call` span). Detects handoffs via `transfer_to_*` tool names and records `handoff.target_agent` on the agent span. Uses `runWithContext` so tool spans inherit the agent span as their parent.
- **`instrumentLangGraph`**: wraps `graph.invoke` (→ `agent_step` span with `runWithContext`) and `graph.stream` (→ one `agent_step` span per node update chunk, with the node name as span name).

### CLI binary (`bin/tracelyx.ts`)

A Node.js HTTP server (`--port`) that accepts Claude Code hook JSON on stdin or as POST body, converts it to a `SpanPayload` of kind `hook`, and forwards it to the Tracelyx ingest API. `session_id` from hook data becomes the `traceId`.

### Disabled mode

Passing `disabled: true` to `TracelyxClient` returns no-op `Trace`/`Span` objects — zero overhead, no network calls.
