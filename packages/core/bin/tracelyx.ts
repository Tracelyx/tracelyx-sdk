#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { TracelyxClient } from '../src/client.js';
import type { SpanPayload } from '../src/types.js';

// ── Shared helpers ─────────────────────────────────────────────────────────

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function buildHookSpan(
  hookName: string,
  hookData: Record<string, unknown>,
): SpanPayload {
  const sessionId =
    typeof hookData['session_id'] === 'string' ? hookData['session_id'] : randomUUID();
  const now = Date.now();
  const executionMs =
    typeof hookData['execution_ms'] === 'number' ? hookData['execution_ms'] : 0;
  const hasError = typeof hookData['tool_error'] === 'string';

  return {
    id: randomUUID(),
    traceId: sessionId,
    parentSpanId: null,
    name: `hook.${hookName}`,
    kind: 'hook',
    startTime: now - executionMs,
    endTime: now,
    durationMs: executionMs,
    status: hasError ? 'error' : 'ok',
    attributes: {
      'hook.name': hookName,
      'hook.session_id': sessionId,
      ...(hasError && { 'error.type': 'hook_error' }),
      ...(hookData['tool_name'] !== undefined && { 'hook.tool_name': hookData['tool_name'] }),
      ...(hookData['tool_input'] !== undefined && {
        'hook.original_input': JSON.stringify(hookData['tool_input']),
      }),
      ...(hookData['tool_response'] !== undefined && {
        'hook.tool_response': JSON.stringify(hookData['tool_response']),
      }),
      ...(typeof hookData['execution_ms'] === 'number' && {
        'hook.execution_ms': hookData['execution_ms'],
      }),
      ...(hasError && {
        'hook.error': hookData['tool_error'],
      }),
      ...(hookData['modified_input'] !== undefined && {
        'hook.modified_input': JSON.stringify(hookData['modified_input']),
      }),
    },
  };
}

// ── hook command (exported for testability) ────────────────────────────────

export async function runHookCommand(
  args: string[],
  stdinData: string,
): Promise<void> {
  const hookName = flagValue(args, '--event') ?? 'UnknownEvent';
  const apiKey = process.env['TRACELYX_API_KEY'];
  const projectId = process.env['TRACELYX_PROJECT_ID'];

  if (!apiKey || !projectId) return;

  let hookData: Record<string, unknown> = {};
  try {
    if (stdinData.trim()) hookData = JSON.parse(stdinData) as Record<string, unknown>;
  } catch {
    return;
  }

  const client = new TracelyxClient({
    apiKey,
    projectId,
    endpoint: process.env['TRACELYX_ENDPOINT'],
  });

  client.recordSpan(buildHookSpan(hookName, hookData));
  await client.flush();
}

// ── hook-listener command ──────────────────────────────────────────────────

async function runHookListenerCommand(args: string[]): Promise<void> {
  const port = parseInt(flagValue(args, '--port') ?? '9735', 10);
  const apiKey = process.env['TRACELYX_API_KEY'];
  const projectId = process.env['TRACELYX_PROJECT_ID'];

  if (!apiKey || !projectId) {
    process.stderr.write('TRACELYX_API_KEY and TRACELYX_PROJECT_ID must be set\n');
    process.exit(1);
  }

  const client = new TracelyxClient({
    apiKey,
    projectId,
    endpoint: process.env['TRACELYX_ENDPOINT'],
  });

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
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

  server.listen(port, () => {
    process.stdout.write(`Tracelyx hook listener running on port ${port}\n`);
  });
}

// ── validate command ─────────────────────────────────────────────────────

export async function runValidateCommand(args: string[]): Promise<void> {
  const apiKey = flagValue(args, '--api-key') ?? process.env['TRACELYX_API_KEY'];
  const projectId = flagValue(args, '--project-id') ?? process.env['TRACELYX_PROJECT_ID'];
  const tenantId = flagValue(args, '--tenant');
  const jsonFlag = args.includes('--json');
  const endpoint = process.env['TRACELYX_ENDPOINT'] ?? 'https://ingest.tracelyx.dev';

  function out(data: unknown): void {
    const d = data as Record<string, unknown>;
    process.stdout.write(
      jsonFlag
        ? JSON.stringify(data) + '\n'
        : String(d['message'] ?? d['error'] ?? JSON.stringify(data)) + '\n',
    );
  }

  if (!apiKey || !projectId) {
    out({ ok: false, error: 'ERROR: --api-key and --project-id are required.' });
    process.exit(1);
  }

  const testTraceId = randomUUID();
  const now = Date.now();
  const payload = {
    projectId,
    environment: 'development',
    ...(tenantId && { tenantId }),
    spans: [
      {
        id: randomUUID(),
        traceId: testTraceId,
        parentSpanId: null,
        name: 'tracelyx.validate',
        kind: 'custom',
        startTime: now,
        endTime: now,
        durationMs: 0,
        status: 'ok',
        attributes: { 'tracelyx.validate': true },
      },
    ],
  };

  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    response = await fetch(`${endpoint}/v1/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    out({ ok: false, error: `ERROR: Cannot reach ${endpoint}. Check your network connection.` });
    process.exit(1);
    return;
  }

  clearTimeout(timer);

  if (response.status === 401) {
    out({ ok: false, error: 'ERROR: API key is invalid or expired. Get a new key at https://app.tracelyx.dev' });
    process.exit(1);
    return;
  }
  if (!response.ok) {
    out({ ok: false, error: `ERROR: Server returned ${response.status}.` });
    process.exit(1);
    return;
  }

  // Receipt confirmation: poll GET /v1/traces/:id until the trace is queryable.
  const retryDelayMs = parseInt(process.env['TRACELYX_VALIDATE_RETRY_DELAY_MS'] ?? '1000', 10);
  let received: Record<string, unknown> | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      const getResponse = await fetch(`${endpoint}/v1/traces/${testTraceId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (getResponse.ok) {
        received = (await getResponse.json()) as Record<string, unknown>;
        break;
      }
    } catch {
      // transient network error — retry
    }
  }

  if (received === null) {
    out({
      ok: false,
      error:
        'ERROR: Test trace was accepted but could not be confirmed via GET /v1/traces/' +
        `${testTraceId}. Check the ingestion pipeline (or that the ingest API exposes GET /v1/traces/:id).`,
    });
    process.exit(1);
    return;
  }

  if (tenantId && received['tenantId'] !== tenantId) {
    out({
      ok: false,
      error: `ERROR: tenant routing failed — expected tenantId "${tenantId}", got "${String(received['tenantId'])}".`,
    });
    process.exit(1);
    return;
  }

  out({
    ok: true,
    message: `✓ Tracelyx configured correctly. Test trace ID: ${testTraceId} visible at https://app.tracelyx.dev/traces/${testTraceId}`,
  });
  process.exit(0);
}

// ── CLI router ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'hook':
      await runHookCommand(args, await readStdin());
      break;
    case 'hook-listener':
      await runHookListenerCommand(args);
      break;
    case 'validate':
      await runValidateCommand(args);
      break;
    default:
      process.stderr.write(`Unknown command: ${command ?? '(none)'}\n`);
      process.stderr.write('Usage: tracelyx <hook|hook-listener|validate> [...args]\n');
      process.exit(1);
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('tracelyx.js') || process.argv[1].endsWith('tracelyx.ts'))
) {
  main().catch((err: unknown) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}
