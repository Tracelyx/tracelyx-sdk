# Tracelyx SDK

Monorepo for the Tracelyx AI observability SDK.

## Packages

| Package | Description |
|---------|-------------|
| [`@tracelyx/core`](./packages/core) | Core tracing client — zero dependencies |

## Quick Start

```typescript
import { TracelyxClient } from '@tracelyx/core';

const client = new TracelyxClient({
  apiKey: 'tlx_...',
  projectId: 'my-project',
});

const trace = client.startTrace({ name: 'agent-run', tenantId: 'acme-corp' });

await trace.trace('llm-call', async () => {
  const span = trace.startSpan('completion', 'llm_call');
  span.setAttribute('llm.model', 'claude-sonnet-4-6');
  // ... your LLM call
  span.end({ 'llm.prompt_tokens': 150, 'llm.completion_tokens': 42 });
});

// call at process exit
await client.flush();
```

## Development

```bash
pnpm install
pnpm build        # build all packages
pnpm test         # run all tests
pnpm check-types  # TypeScript check
```

## License

MIT
