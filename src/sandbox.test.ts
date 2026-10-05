import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SandboxDeploymentError } from './errors.js';
import { Sandbox } from './sandbox.js';
import { completeEvent, sseResponse } from './test-support.js';

// --- Fake fetch (system-boundary seam: the Koyeb public API and the sandbox gateway) ---

const API = 'http://api.test';
const GATEWAY = 'http://gateway.test';

type Call = { method: string; url: string; path: string; headers: Headers };
type Handler = (call: Call) => Response | Error | Promise<Response | Error>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function service(overrides: Record<string, unknown> = {}) {
  return { id: 'svc-1', app_id: 'app-1', name: 'sb', latest_deployment_id: 'dep-1', ...overrides };
}

function deployment(status: string | undefined, overrides: Record<string, unknown> = {}) {
  return {
    id: 'dep-1',
    status,
    definition: { env: [{ key: 'SANDBOX_SECRET', value: 'secret-1' }] },
    metadata: { sandbox: { public_url: GATEWAY, routing_key: 'ns:svc-1' } },
    ...overrides,
  };
}

/**
 * Routes each request to `routes['<METHOD> <path>']`: a handler, or a list of responses served in order (the last
 * one repeats).
 */
function fakeFetch(routes: Record<string, Handler | (Response | Error)[]>) {
  const calls: Call[] = [];
  const served: Record<string, number> = {};

  const fetch = vi.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const call = { method: request.method, url: request.url, path: url.pathname, headers: request.headers };
    calls.push(call);

    const key = `${call.method} ${call.path}`;
    const route = routes[key];

    if (route === undefined) {
      throw new Error(`unexpected fetch: ${key}`);
    }

    let next: Response | Error;

    if (typeof route === 'function') {
      next = await route(call);
    } else {
      const index = Math.min(served[key] ?? 0, route.length - 1);
      served[key] = (served[key] ?? 0) + 1;
      next = route[index];
    }

    if (next instanceof Error) {
      throw next;
    }

    return next.clone();
  });

  return { fetch, calls };
}

const keys = (calls: Call[]) => calls.map((call) => `${call.method} ${call.path}`);

beforeEach(() => {
  vi.stubEnv('KOYEB_API_HOST', API);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Sandbox.create', () => {
  it('creates the app and service without a dry run, then waits for HEALTHY before probing /health', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v1/apps': [jsonResponse({ app: { id: 'app-1' } })],
      'POST /v1/services': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [
        jsonResponse({ deployment: deployment('PROVISIONING') }),
        jsonResponse({ deployment: deployment('STARTING') }),
        jsonResponse({ deployment: deployment('HEALTHY') }),
      ],
      'GET /koyeb-sandbox/health': [jsonResponse({ status: 'ok' })],
    });
    vi.stubGlobal('fetch', fetch);

    const sandbox = await Sandbox.create({ api_token: 'token', name: 'sb' });

    expect(sandbox.service_id).toBe('svc-1');
    expect(keys(calls)).toEqual([
      'POST /v1/apps',
      'POST /v1/services',
      'GET /v1/deployments/dep-1',
      'GET /v1/deployments/dep-1',
      'GET /v1/deployments/dep-1',
      'GET /koyeb-sandbox/health',
    ]);
    expect(calls.some((call) => call.url.includes('dry_run'))).toBe(false);

    const health = calls[calls.length - 1];
    expect(health.url).toBe(`${GATEWAY}/koyeb-sandbox/health`);
    expect(health.headers.get('X-Routing-Key')).toBe('ns:svc-1');
    expect(health.headers.get('Authorization')).toMatch(/^Bearer .+/);
  });

  it('fails at once on a terminal deployment status, deleting the app', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v1/apps': [jsonResponse({ app: { id: 'app-1' } })],
      'POST /v1/services': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [
        jsonResponse({ deployment: deployment('STARTING') }),
        jsonResponse({ deployment: deployment('ERROR') }),
      ],
      'DELETE /v1/apps/app-1': [jsonResponse({ app: { id: 'app-1' } })],
    });
    vi.stubGlobal('fetch', fetch);

    const error = await Sandbox.create({ api_token: 'token', name: 'sb' }).catch((error) => error);

    expect(error).toBeInstanceOf(SandboxDeploymentError);
    expect(error).toMatchObject({ sandbox_name: 'sb', status: 'ERROR' });
    expect(keys(calls)).not.toContain('GET /koyeb-sandbox/health');
    expect(keys(calls).at(-1)).toBe('DELETE /v1/apps/app-1');
  });

  it('resolves the deployment from the service when the create reply has none', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v1/apps': [jsonResponse({ app: { id: 'app-1' } })],
      'POST /v1/services': [jsonResponse({ service: service({ latest_deployment_id: undefined }) })],
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [jsonResponse({ deployment: deployment('HEALTHY') })],
      'GET /koyeb-sandbox/health': [jsonResponse({ status: 'ok' })],
    });
    vi.stubGlobal('fetch', fetch);

    await Sandbox.create({ api_token: 'token', name: 'sb' });

    expect(keys(calls)).toEqual([
      'POST /v1/apps',
      'POST /v1/services',
      'GET /v1/services/svc-1',
      'GET /v1/deployments/dep-1',
      'GET /koyeb-sandbox/health',
    ]);
  });
});

describe('Sandbox.update_lifecycle', () => {
  it('pins the deployment its update creates, so a later wait_ready follows it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { fetch, calls } = fakeFetch({
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [jsonResponse({ deployment: deployment('HEALTHY') })],
      'PUT /v1/services/svc-1': [jsonResponse({ service: service({ latest_deployment_id: 'dep-2' }) })],
      'GET /v1/deployments/dep-2': [jsonResponse({ deployment: deployment('HEALTHY', { id: 'dep-2' }) })],
      'GET /koyeb-sandbox/health': [jsonResponse({ status: 'ok' })],
    });
    vi.stubGlobal('fetch', fetch);

    const sandbox = await Sandbox.get_from_id('svc-1', 'token');
    await sandbox.update_lifecycle({ delete_after_delay: 600 });

    const pending = sandbox.wait_ready();
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toBe(true);
    // wait_ready polls the pinned dep-2, not the superseded dep-1.
    expect(keys(calls)).toEqual([
      'GET /v1/services/svc-1',
      'GET /v1/deployments/dep-1',
      'GET /v1/services/svc-1',
      'GET /v1/deployments/dep-1',
      'PUT /v1/services/svc-1',
      'GET /v1/deployments/dep-2',
      'GET /koyeb-sandbox/health',
    ]);
  });
});

describe('Sandbox.wait_ready', () => {
  function handle() {
    return new Sandbox('app-1', 'svc-1', 'sb', 'secret-1', 'token');
  }

  it('polls with backoff from 0.1 s doubling up to 0.5 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const polls: number[] = [];
    const start = Date.now();
    const { fetch } = fakeFetch({
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': () => {
        polls.push(Date.now() - start);
        return jsonResponse({ deployment: deployment(polls.length < 7 ? 'STARTING' : 'HEALTHY') });
      },
      'GET /koyeb-sandbox/health': [jsonResponse({ status: 'ok' })],
    });
    vi.stubGlobal('fetch', fetch);

    const pending = handle().wait_ready();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toBe(true);
    expect(polls).toEqual([0, 100, 300, 700, 1200, 1700, 2200]);
  });

  it('retries /health on a network error or a non-2xx reply, at the same backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { fetch, calls } = fakeFetch({
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [jsonResponse({ deployment: deployment('HEALTHY') })],
      'GET /koyeb-sandbox/health': [
        new TypeError('fetch failed'),
        jsonResponse({ error: 'no healthy upstream' }, 503),
        jsonResponse({ status: 'ok' }),
      ],
    });
    vi.stubGlobal('fetch', fetch);

    const pending = handle().wait_ready();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe(true);
    // HEALTHY is seen once: the deployment is not polled again while /health is retried.
    expect(keys(calls)).toEqual([
      'GET /v1/services/svc-1',
      'GET /v1/deployments/dep-1',
      'GET /koyeb-sandbox/health',
      'GET /koyeb-sandbox/health',
      'GET /koyeb-sandbox/health',
    ]);
  });

  it('treats API errors on the deployment poll as not ready yet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { fetch } = fakeFetch({
      'GET /v1/services/svc-1': [
        jsonResponse({ error: { message: 'unavailable' } }, 503),
        jsonResponse({ service: service() }),
      ],
      'GET /v1/deployments/dep-1': [
        jsonResponse({ error: { message: 'unavailable' } }, 503),
        jsonResponse({ deployment: deployment('HEALTHY') }),
      ],
      'GET /koyeb-sandbox/health': [jsonResponse({ status: 'ok' })],
    });
    vi.stubGlobal('fetch', fetch);

    const pending = handle().wait_ready();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe(true);
  });

  it.each(['STOPPED', 'SLEEPING', 'CANCELED', 'SOMETHING_NEW'])('throws on the terminal status %s', async (status) => {
    const { fetch } = fakeFetch({
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [jsonResponse({ deployment: deployment(status) })],
    });
    vi.stubGlobal('fetch', fetch);

    await expect(handle().wait_ready()).rejects.toBeInstanceOf(SandboxDeploymentError);
  });

  it('resolves false on timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { fetch } = fakeFetch({
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [jsonResponse({ deployment: deployment('STARTING') })],
    });
    vi.stubGlobal('fetch', fetch);

    const pending = handle().wait_ready(2);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toBe(false);
  });

  it('resolves false once the signal aborts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { fetch } = fakeFetch({
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [jsonResponse({ deployment: deployment('STARTING') })],
    });
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();

    const pending = handle().wait_ready(300, 0.5, controller.signal);
    await vi.advanceTimersByTimeAsync(250);
    controller.abort();

    await expect(pending).resolves.toBe(false);
  });
});

describe('Sandbox.get_from_id', () => {
  it('keeps the connection info, so the first exec sends no more API requests', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [jsonResponse({ deployment: deployment('HEALTHY') })],
      'POST /koyeb-sandbox/run_streaming': [sseResponse([completeEvent({ code: 0, error: false })])],
    });
    vi.stubGlobal('fetch', fetch);

    const sandbox = await Sandbox.get_from_id('svc-1', 'token');
    await sandbox.exec('true');

    expect(keys(calls)).toEqual([
      'GET /v1/services/svc-1',
      'GET /v1/deployments/dep-1',
      'POST /koyeb-sandbox/run_streaming',
    ]);
    const run = calls[2];
    expect(run.url).toBe(`${GATEWAY}/koyeb-sandbox/run_streaming`);
    expect(run.headers.get('X-Routing-Key')).toBe('ns:svc-1');
    expect(run.headers.get('Authorization')).toBe('Bearer secret-1');
  });

  it('falls back to resolving the connection on first use when the deployment has no sandbox metadata', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [
        jsonResponse({ deployment: deployment('STARTING', { metadata: {} }) }),
        jsonResponse({ deployment: deployment('HEALTHY') }),
      ],
      'POST /koyeb-sandbox/run_streaming': [sseResponse([completeEvent({ code: 0, error: false })])],
    });
    vi.stubGlobal('fetch', fetch);

    const sandbox = await Sandbox.get_from_id('svc-1', 'token');
    await sandbox.exec('true');

    expect(keys(calls)).toEqual([
      'GET /v1/services/svc-1',
      'GET /v1/deployments/dep-1',
      'GET /v1/deployments/dep-1',
      'POST /koyeb-sandbox/run_streaming',
    ]);
  });

  it('waits on the deployment it read, without another service lookup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { fetch, calls } = fakeFetch({
      'GET /v1/services/svc-1': [jsonResponse({ service: service() })],
      'GET /v1/deployments/dep-1': [jsonResponse({ deployment: deployment('HEALTHY') })],
      'GET /koyeb-sandbox/health': [jsonResponse({ status: 'ok' })],
    });
    vi.stubGlobal('fetch', fetch);

    const sandbox = await Sandbox.get_from_id('svc-1', 'token');
    const pending = sandbox.wait_ready();
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toBe(true);
    expect(keys(calls)).toEqual([
      'GET /v1/services/svc-1',
      'GET /v1/deployments/dep-1',
      'GET /v1/deployments/dep-1',
      'GET /koyeb-sandbox/health',
    ]);
  });
});
