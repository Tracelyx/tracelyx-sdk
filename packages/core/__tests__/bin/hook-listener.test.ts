import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHookListenerServer } from '../../bin/tracelyx.js';
import { TracelyxClient } from '../../src/client.js';
import type { TracePayload } from '../../src/types.js';
import type { AddressInfo } from 'net';

// `vi.stubGlobal('fetch', ...)` replaces the *global* fetch identifier, which
// would also swallow this test file's own HTTP requests to the real server
// under test (they'd hit the mock instead of the loopback socket). Capture
// the real implementation first and use it for the test-side requests below;
// the stub only needs to intercept the TracelyxClient's outbound calls.
const realFetch = globalThis.fetch;

describe('hook-listener server', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: TracelyxClient;
  let server: import('http').Server;
  let base: string;

  beforeEach(async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{"accepted":1}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    client = new TracelyxClient({ apiKey: 'tl_test', projectId: 'proj_1' });
    server = createHookListenerServer(client);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await client.flush();
    await new Promise<void>((r) => server.close(() => r()));
    vi.unstubAllGlobals();
  });

  it('binds to loopback (127.0.0.1)', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('returns 413 for a body larger than 1 MB (clean status, not a reset)', async () => {
    const big = 'x'.repeat(1_048_577);
    const res = await realFetch(`${base}/hook`, { method: 'POST', body: big });
    expect(res.status).toBe(413);
  });

  it('returns 404 for a non-POST or wrong path', async () => {
    expect((await realFetch(`${base}/hook`, { method: 'GET' })).status).toBe(404);
    expect((await realFetch(`${base}/nope`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('returns 400 for invalid JSON and records no span', async () => {
    const res = await realFetch(`${base}/hook`, { method: 'POST', body: 'not-json' });
    expect(res.status).toBe(400);
    await client.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 200 and records a hook span for a valid event', async () => {
    const res = await realFetch(`${base}/hook`, {
      method: 'POST',
      body: JSON.stringify({ event: 'PostToolUse', session_id: 's1', tool_name: 'Bash' }),
    });
    expect(res.status).toBe(200);
    await client.flush();
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as TracePayload;
    expect(body.spans[0].kind).toBe('hook');
    expect(body.spans[0].name).toBe('hook.PostToolUse');
  });
});
