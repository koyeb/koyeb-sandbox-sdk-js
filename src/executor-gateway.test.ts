import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});

import { ExecutorGateway } from './executor-gateway.js';
import { SandboxError, SandboxRequestError, SandboxServiceError } from './errors.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('ExecutorGateway.post', () => {
  it('retries 5xx through the send seam, then succeeds', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response('down', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const gateway = new ExecutorGateway(send);

    const body = await gateway.post('/run', { method: 'POST' }, { cmd: 'ls' });

    expect(body).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual(['/run', { method: 'POST' }, { cmd: 'ls' }]);
  });

  it('surfaces persistent 5xx as SandboxServiceError', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => new Response('down', { status: 500 }));
    const gateway = new ExecutorGateway(send);

    const pending = gateway.post('/run', { method: 'POST' });
    const assertion = expect(pending).rejects.toBeInstanceOf(SandboxServiceError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(send).toHaveBeenCalledTimes(4);
  });

  it('maps 4xx to SandboxRequestError without retrying', async () => {
    const send = vi.fn(async () => new Response('bad', { status: 400 }));
    const gateway = new ExecutorGateway(send);

    const error = await gateway.post('/run', { method: 'POST' }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries network failures and wraps persistent ones in SandboxError', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const gateway = new ExecutorGateway(send);

    const body = await gateway.post('/run', { method: 'POST' });
    expect(body).toEqual({ ok: true });

    vi.useFakeTimers();
    const persistent = new ExecutorGateway(vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));

    const pending = persistent.post('/run', { method: 'POST' });
    const errorPromise = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(SandboxError);
    expect((error as Error).message).toContain('Request to sandbox executor failed');
  });

  it('fails fast on aborts without retrying', async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn(async () => Promise.reject(new DOMException('aborted', 'AbortError')));
    const gateway = new ExecutorGateway(send);

    const error = await gateway
      .post('/run', { method: 'POST', signal: controller.signal })
      .catch((error: unknown) => error);

    expect(send).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DOMException);
  });

  it('parses JSON bodies and passes text through', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ a: 1 }))
      .mockResolvedValueOnce(new Response('plain', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    const gateway = new ExecutorGateway(send);

    expect(await gateway.post('/a', {})).toEqual({ a: 1 });
    expect(await gateway.post('/b', {})).toBe('plain');
  });

  it('re-arms the deadline hook on every attempt', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onAttempt = vi.fn();
    const gateway = new ExecutorGateway(send);

    await gateway.post('/run', { method: 'POST' }, undefined, { onAttempt });

    expect(onAttempt).toHaveBeenCalledTimes(2);
  });
});

describe('ExecutorGateway.raw', () => {
  it('maps 5xx and 4xx to the taxonomy and passes OK responses through', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(new Response('bad', { status: 404 }))
      .mockResolvedValueOnce(new Response('stream', { status: 200 }));
    const gateway = new ExecutorGateway(send);

    await expect(gateway.raw('/run_streaming', {})).rejects.toBeInstanceOf(SandboxServiceError);
    await expect(gateway.raw('/run_streaming', {})).rejects.toBeInstanceOf(SandboxRequestError);
    const response = await gateway.raw('/run_streaming', {});
    expect(response).toBeInstanceOf(Response);
    expect(await response.text()).toBe('stream');
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('ExecutorGateway.health', () => {
  it('reports the response status and bounds the probe', async () => {
    const send = vi.fn(async (_path: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response('OK', { status: 200 });
    });
    const gateway = new ExecutorGateway(send);

    expect(await gateway.health()).toBe(true);

    const failing = new ExecutorGateway(vi.fn(async () => new Response('no', { status: 503 })));
    expect(await failing.health()).toBe(false);
  });

  it('treats transport failures as not healthy', async () => {
    const gateway = new ExecutorGateway(vi.fn(async () => Promise.reject(new TypeError('down'))));

    expect(await gateway.health()).toBe(false);
  });
});
