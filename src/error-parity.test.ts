import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KoyebApi } from './api.js';
import { Sandbox } from './sandbox.js';
import { makeSandbox, mockExec } from './test-support.js';
import {
  NoSandboxSecretError,
  SandboxApiError,
  SandboxDeploymentError,
  SandboxError,
  SandboxFileExistsError,
  SandboxFileNotFoundError,
  SandboxFilesystemError,
  SandboxRequestError,
  SandboxServiceError,
  ServiceTerminalStateError,
} from './errors.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('API error taxonomy', () => {
  it('wraps API errors in SandboxApiError extending SandboxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'not found' }), { status: 404 })),
    );

    const api = new KoyebApi('token');
    const error = await api.getServicePool('pool-1').catch((e: unknown) => e);

    // One catch for the whole SDK: API failures must be SandboxErrors.
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toBeInstanceOf(SandboxApiError);
    expect((error as SandboxApiError).status).toBe(404);
    expect((error as SandboxApiError).body).toEqual({ message: 'not found' });
  });

  it('surfaces the API error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'pool is draining' }), { status: 409 })),
    );

    const api = new KoyebApi('token');
    const error = await api.getServicePool('pool-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxApiError);
    expect((error as SandboxApiError).message).toContain('pool is draining');
  });
});

describe('executor error hierarchy parity', () => {
  it('SandboxServiceError extends SandboxRequestError so one catch covers executor HTTP failures', () => {
    const error = new SandboxServiceError(503, 'unavailable');

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error.status_code).toBe(503);
    expect(error.body).toBe('unavailable');
    expect(error.message).toBe('Sandbox service error (503): unavailable');
  });

  it('SandboxRequestError carries the status code and body like the Python SDK', () => {
    const error = new SandboxRequestError(404, { message: 'nope' });

    expect(error.status_code).toBe(404);
    expect(error.body).toEqual({ message: 'nope' });
    expect(error.message).toBe('Sandbox executor request failed: 404 {"message":"nope"}');
  });

  it('NoSandboxSecretError takes a contextual message, defaulting to the env-var hint', () => {
    expect(new NoSandboxSecretError().message).toBe(
      'The SANDBOX_SECRET environment variable is not set',
    );
    expect(new NoSandboxSecretError('custom context').message).toBe('custom context');
  });

  it('deployment errors name the recovery like the Python SDK', () => {
    expect(new SandboxDeploymentError('sbx', 'ERROR').message).toBe(
      "Sandbox 'sbx' deployment reached status ERROR — it will not become ready; wake or redeploy the sandbox.",
    );
  });
});

describe('executor 503 retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('retries 5xx with exact 1s/2s doubling backoff, then succeeds', async () => {
    const sandbox = makeSandbox();
    const responses = [
      new Response('unavailable', { status: 503 }),
      new Response('bad gateway', { status: 502 }),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ];
    const fetchSpy = vi.spyOn(sandbox, 'fetch').mockImplementation(async () => responses.shift()!);

    const pending = sandbox.request('/run', { method: 'POST' }, { cmd: 'ls' });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const body = await pending;

    expect(body).toEqual({ ok: true });
  });

  it('retries network errors with the same backoff, wrapping persistent ones', async () => {
    const sandbox = makeSandbox();
    const failures = [new TypeError('fetch failed'), new TypeError('fetch failed')];
    const fetchSpy = vi
      .spyOn(sandbox, 'fetch')
      .mockImplementationOnce(async () => {
        throw failures[0];
      })
      .mockImplementationOnce(async () => {
        throw failures[1];
      })
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const pending = sandbox.request('/run', { method: 'POST' }, { cmd: 'ls' });
    // Backoffs are 1s then 2s; the third attempt succeeds.
    await vi.advanceTimersByTimeAsync(3_000);
    const body = await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(body).toEqual({ ok: true });

    const persistent = makeSandbox();
    vi.spyOn(persistent, 'fetch').mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });

    const done = expect(
      persistent.request('/run', { method: 'POST' }, { cmd: 'ls' }),
    ).rejects.toMatchObject({ message: 'Request to sandbox executor failed: TypeError: fetch failed' });
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
  });

  it('does not retry abort-driven failures', async () => {
    const sandbox = makeSandbox();
    const controller = new AbortController();
    controller.abort();
    const fetchSpy = vi.spyOn(sandbox, 'fetch').mockImplementation(async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    const error = await sandbox
      .request('/run', { method: 'POST', signal: controller.signal }, { cmd: 'ls' })
      .catch((error: unknown) => error);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DOMException);
  });

  it('throws SandboxServiceError when 503s persist past the retry budget', async () => {
    const sandbox = makeSandbox();
    const fetchSpy = vi.spyOn(sandbox, 'fetch').mockImplementation(async () => new Response('unavailable', { status: 503 }));

    const pending = sandbox.request('/run', { method: 'POST' }, { cmd: 'ls' });
    const instance = expect(pending).rejects.toBeInstanceOf(SandboxServiceError);
    const family = expect(pending).rejects.toBeInstanceOf(SandboxError);
    const fields = expect(pending).rejects.toMatchObject({ status_code: 503 });
    await vi.advanceTimersByTimeAsync(30_000);
    await instance;
    await family;
    await fields;

    // 1 initial attempt + 3 retries, matching the Python client's budget.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('does not retry 4xx responses', async () => {
    const sandbox = makeSandbox();
    const fetchSpy = vi
      .spyOn(sandbox, 'fetch')
      .mockImplementation(async () => new Response('bad request', { status: 400 }));

    await expect(sandbox.request('/run', { method: 'POST' }, { cmd: 'ls' })).rejects.toBeInstanceOf(
      SandboxRequestError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('filesystem parity', () => {
  function mockRequest(sandbox: Sandbox, result: unknown) {
    return vi.spyOn(sandbox, 'request').mockResolvedValue(result as never);
  }


  it('move_file quotes both paths', async () => {
    const sandbox = makeSandbox();
    const fetch = mockExec(sandbox, { code: 0 });

    await sandbox.filesystem.move_file('/tmp/a b', '/tmp/c; rm -rf /');

    expect(fetch.mock.calls[0][2]).toMatchObject({ cmd: `mv '/tmp/a b' '/tmp/c; rm -rf /'` });
  });

  it('move_file maps the executor\'s not-found strings to SandboxFileNotFoundError', async () => {
    const sandbox = makeSandbox();
    mockExec(sandbox, { stderr: 'mv: /tmp/gone: No such file or directory', code: 1 });

    await expect(sandbox.filesystem.move_file('/tmp/gone', '/tmp/x')).rejects.toBeInstanceOf(
      SandboxFileNotFoundError,
    );
  });

  it('move_file surfaces other failures as SandboxFilesystemError', async () => {
    const sandbox = makeSandbox();
    mockExec(sandbox, { stderr: 'permission denied', code: 1 });

    await expect(sandbox.filesystem.move_file('/tmp/a', '/tmp/x')).rejects.toBeInstanceOf(
      SandboxFilesystemError,
    );
  });

  it('rename_file delegates to move_file semantics', async () => {
    const sandbox = makeSandbox();
    mockExec(sandbox, { stderr: 'mv: /tmp/gone: No such file or directory', code: 1 });

    await expect(sandbox.filesystem.rename_file('/tmp/gone', '/tmp/x')).rejects.toBeInstanceOf(
      SandboxFileNotFoundError,
    );
  });

  it('delete_file hits the dedicated executor endpoint', async () => {
    const sandbox = makeSandbox();
    const request = mockRequest(sandbox, {});

    await sandbox.filesystem.delete_file('/tmp/a b');

    expect(request.mock.calls[0][0]).toBe('/delete_file');
    expect(request.mock.calls[0][2]).toEqual({ path: '/tmp/a b' });
  });

  it('delete_file maps the executor\'s not-found strings to SandboxFileNotFoundError', async () => {
    const sandbox = makeSandbox();
    mockRequest(sandbox, { error: 'remove /tmp/gone: no such file or directory' });

    await expect(sandbox.filesystem.delete_file('/tmp/gone')).rejects.toBeInstanceOf(
      SandboxFileNotFoundError,
    );
  });

  it('rm maps not-found and other failures like Python', async () => {
    const missing = makeSandbox();
    mockExec(missing, { stderr: 'rm: /gone: no such file or directory', code: 1 });

    const error = await missing.filesystem.rm('/gone').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SandboxFileNotFoundError);
    expect((error as Error).message).toBe('File not found: /gone');

    const denied = makeSandbox();
    mockExec(denied, { stderr: 'rm: /root: permission denied', code: 1 });

    const other = await denied.filesystem.rm('/root').catch((error: unknown) => error);
    expect(other).toBeInstanceOf(SandboxFilesystemError);
    expect((other as Error).message).toBe('Failed to remove: rm: /root: permission denied');
  });

  it('delete_file keeps the exists mapping available', async () => {
    const sandbox = makeSandbox();
    mockRequest(sandbox, { error: 'remove /tmp/a: file exists' });

    await expect(sandbox.filesystem.delete_file('/tmp/a')).rejects.toBeInstanceOf(SandboxFileExistsError);
  });
});

describe('deployment failure detection', () => {
  it('raises SandboxDeploymentError when the active deployment is terminal', async () => {
    const sandbox = makeSandbox();
    const api = (sandbox as unknown as { api: KoyebApi }).api;

    vi.spyOn(api, 'getService').mockResolvedValue({ active_deployment_id: 'dep-1' } as never);
    vi.spyOn(api, 'getDeployment').mockResolvedValue({ status: 'ERROR' } as never);

    const error = await sandbox.is_healthy().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxDeploymentError);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxDeploymentError).message).toContain('ERROR');
  });

  it('treats control-plane blips as not-yet-healthy instead of raising', async () => {
    const sandbox = makeSandbox();
    const api = (sandbox as unknown as { api: KoyebApi }).api;

    vi.spyOn(api, 'getService').mockRejectedValue(new SandboxError('transient blip'));

    await expect(sandbox.is_healthy()).resolves.toBe(false);
  });

  it('swallows executor-side failures as not-yet-healthy', async () => {
    const sandbox = makeSandbox();
    const api = (sandbox as unknown as { api: KoyebApi }).api;

    vi.spyOn(api, 'getService').mockResolvedValue({ active_deployment_id: 'dep-1' } as never);
    vi.spyOn(api, 'getDeployment').mockResolvedValue({ status: 'HEALTHY' } as never);
    vi.spyOn(api, 'getApp').mockRejectedValue(new SandboxError('no domain yet'));

    await expect(sandbox.is_healthy()).resolves.toBe(false);
  });
});
