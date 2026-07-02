import { describe, it, expect, vi, afterEach } from 'vitest';
import { runValidateCommand } from '../../bin/tracelyx.js';

function mockPostOkGetTrace(getResponses: Array<{ status: number; body?: unknown }>) {
  let getCall = 0;
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve(new Response('{"accepted":1}', { status: 200 }));
    }
    const r = getResponses[Math.min(getCall++, getResponses.length - 1)];
    return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), { status: r.status }));
  });
}

describe('validate command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('exits 0 and prints success when server returns 200', async () => {
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    vi.stubGlobal(
      'fetch',
      mockPostOkGetTrace([{ status: 200, body: { id: 't-1', tenantId: 'acme-corp' } }]),
    );

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit(${code})`);
      }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1']);
    } catch {
      // expected to throw when process.exit is mocked
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    const output = stdoutLines.join('');
    expect(output).toContain('✓ Tracelyx configured correctly');
  });

  it('exits 1 and prints error when server returns 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 401 })),
    );

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit(${code})`);
      }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_invalid', '--project-id', 'proj_1']);
    } catch {
      // expected to throw when process.exit is mocked
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = stdoutLines.join('');
    expect(output).toContain('invalid or expired');
  });

  it('exits 1 without calling fetch when api-key is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit(${code})`);
      }) as (code?: number) => never);

    try {
      await runValidateCommand(['--project-id', 'proj_1']); // no --api-key
    } catch {
      // expected to throw when process.exit is mocked
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits 1 without calling fetch when project-id is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit(${code})`);
      }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test']); // no --project-id
    } catch {
      // expected to throw when process.exit is mocked
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('outputs JSON when --json flag is set', async () => {
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    vi.stubGlobal(
      'fetch',
      mockPostOkGetTrace([{ status: 200, body: { id: 't-1', tenantId: 'acme-corp' } }]),
    );

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1', '--json']);
    } catch {
      // expected to throw when process.exit is mocked
    }

    const output = stdoutLines.join('').trim();
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.message).toBe('string');
  });

  it('sends correct payload with tenant when --tenant is provided', async () => {
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    const fetchMock = mockPostOkGetTrace([{ status: 200, body: { id: 't-1', tenantId: 'tenant_123' } }]);
    vi.stubGlobal('fetch', fetchMock);

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1', '--tenant', 'tenant_123']);
    } catch {
      // expected to throw when process.exit is mocked
    }

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const callArgs = fetchMock.mock.calls[0];
    const payload = JSON.parse(callArgs[1].body);
    expect(payload.tenantId).toBe('tenant_123');
    expect(payload.projectId).toBe('proj_1');
  });

  it('exits 1 on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit(${code})`);
      }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1']);
    } catch {
      // expected to throw when process.exit is mocked
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = stdoutLines.join('');
    expect(output).toContain('Cannot reach');
  });

  it('exits 1 on server error with non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 500 })),
    );

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit(${code})`);
      }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1']);
    } catch {
      // expected to throw when process.exit is mocked
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = stdoutLines.join('');
    expect(output).toContain('Server returned');
  });

  it('reads api-key from TRACELYX_API_KEY env when --api-key arg is not provided', async () => {
    vi.stubEnv('TRACELYX_API_KEY', 'tl_from_env');
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    vi.stubGlobal(
      'fetch',
      mockPostOkGetTrace([{ status: 200, body: { id: 't-1', tenantId: 'acme-corp' } }]),
    );

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--project-id', 'proj_1']);
    } catch {
      // expected to throw when process.exit is mocked
    }

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const callArgs = fetchMock.mock.calls[0];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tl_from_env');
  });

  it('reads project-id from TRACELYX_PROJECT_ID env when --project-id arg is not provided', async () => {
    vi.stubEnv('TRACELYX_PROJECT_ID', 'proj_from_env');
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    vi.stubGlobal(
      'fetch',
      mockPostOkGetTrace([{ status: 200, body: { id: 't-1', tenantId: 'acme-corp' } }]),
    );

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });

    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test']);
    } catch {
      // expected to throw when process.exit is mocked
    }

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const callArgs = fetchMock.mock.calls[0];
    const payload = JSON.parse(callArgs[1].body);
    expect(payload.projectId).toBe('proj_from_env');
  });

  it('success message includes app URL', async () => {
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    vi.stubGlobal(
      'fetch',
      mockPostOkGetTrace([{ status: 200, body: { id: 't-1', tenantId: 'acme-corp' } }]),
    );
    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1']);
    } catch { /* expected */ }

    const output = stdoutLines.join('');
    expect(output).toContain('https://app.tracelyx.dev/traces/');
  });

  it('401 error message includes new-key URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 401 })),
    );
    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_invalid', '--project-id', 'proj_1']);
    } catch { /* expected */ }

    const output = stdoutLines.join('');
    expect(output).toContain('https://app.tracelyx.dev');
  });

  it('confirms receipt via GET after POST and exits 0', async () => {
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    const fetchMock = mockPostOkGetTrace([{ status: 200, body: { id: 't-1' } }]);
    vi.stubGlobal('fetch', fetchMock);

    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1']);
    } catch {
      // expected
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
    const getCalls = fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST');
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(getCalls[0][0])).toMatch(/\/v1\/traces\/[0-9a-f-]+$/);
    expect(getCalls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(stdoutLines.join('')).toContain('✓ Tracelyx configured correctly');
  });

  it('retries GET on 404 and succeeds when trace appears', async () => {
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    const fetchMock = mockPostOkGetTrace([{ status: 404 }, { status: 404 }, { status: 200, body: { id: 't-1' } }]);
    vi.stubGlobal('fetch', fetchMock);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1']);
    } catch {
      // expected
    }
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 when trace never becomes retrievable (receipt not confirmed)', async () => {
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    const fetchMock = mockPostOkGetTrace([{ status: 404 }]);
    vi.stubGlobal('fetch', fetchMock);
    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1']);
    } catch {
      // expected
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stdoutLines.join('')).toContain('accepted but could not be confirmed');
  });

  it('verifies tenant routing: exits 1 when GET returns different tenantId', async () => {
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    const fetchMock = mockPostOkGetTrace([{ status: 200, body: { id: 't-1', tenantId: 'other-corp' } }]);
    vi.stubGlobal('fetch', fetchMock);
    const stdoutLines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1', '--tenant', 'acme-corp']);
    } catch {
      // expected
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stdoutLines.join('')).toContain('tenant routing');
  });

  it('verifies tenant routing: exits 0 when GET returns matching tenantId', async () => {
    vi.stubEnv('TRACELYX_VALIDATE_RETRY_DELAY_MS', '0');
    const fetchMock = mockPostOkGetTrace([{ status: 200, body: { id: 't-1', tenantId: 'acme-corp' } }]);
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as (code?: number) => never);

    try {
      await runValidateCommand(['--api-key', 'tl_test', '--project-id', 'proj_1', '--tenant', 'acme-corp']);
    } catch {
      // expected
    }
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
