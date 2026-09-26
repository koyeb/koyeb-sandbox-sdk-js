import { afterEach, describe, expect, it, vi } from 'vitest';

import { claim, get_claim, wait_claim_ready, type ClaimResult } from './claim.js';
import { DEFAULT_CLAIM_POLL_INTERVAL } from './constants.js';
import { MissingApiTokenError, PoolClaimError, ServiceTerminalStateError } from './errors.js';

// --- Fake fetch factory (system-boundary seam: the Koyeb public API) ---

type FetchCall = { url: string; method: string; body?: unknown };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function claimReply(overrides: Record<string, unknown> = {}) {
  return jsonResponse({ claim_id: 'claim-1', service_id: 'svc-1', prewarmed: false, ...overrides });
}

function serviceReply(status: string | undefined) {
  return jsonResponse({ service: status === undefined ? {} : { status } });
}

function apiError(status: number, message = 'boom') {
  return jsonResponse({ error: { message } }, status);
}

function fakeFetch(responses: (Response | Error)[], options: { repeatLast?: boolean } = {}) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetch = vi.fn(async (request: Request) => {
    calls.push({
      url: request.url,
      method: request.method,
      body: request.method === 'POST' ? await request.clone().json() : undefined,
    });

    let next = queue.shift();

    if (next === undefined && options.repeatLast) {
      next = responses[responses.length - 1];
    }

    if (next === undefined) {
      throw new Error(`unexpected fetch #${calls.length}: ${request.method} ${request.url}`);
    }

    if (next instanceof Error) {
      throw next;
    }

    return next.clone();
  });

  return { fetch, calls };
}

const claim_result: ClaimResult = {
  claim_id: 'claim-1',
  pool_id: 'pool-1',
  request_id: 'req-1',
  service_id: 'svc-1',
  prewarmed: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('claim', () => {
  it('sends pool_id and a generated request_id to POST /v1/claim and maps the reply', async () => {
    const { fetch, calls } = fakeFetch([claimReply()]);
    vi.stubGlobal('fetch', fetch);

    const result = await claim('pool-1', { api_token: 'token' });

    expect(result).toEqual({
      claim_id: 'claim-1',
      pool_id: 'pool-1',
      request_id: expect.stringMatching(UUID_V4),
      service_id: 'svc-1',
      prewarmed: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toMatch(/\/v1\/claim$/);
    expect(calls[0].body).toEqual({ pool_id: 'pool-1', request_id: result.request_id });
  });

  it('reuses the same request_id across internal retries', async () => {
    const { fetch, calls } = fakeFetch([apiError(500), apiError(500), claimReply()]);
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const pending = claim('pool-1', { api_token: 'token' });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;

    expect(result.service_id).toBe('svc-1');
    expect(calls).toHaveLength(3);
    const requestIds = new Set(calls.map((call) => (call.body as { request_id: string }).request_id));
    expect(requestIds.size).toBe(1);
  });

  it('gives up after 3 attempts, surfacing the last error', async () => {
    const { fetch, calls } = fakeFetch([apiError(500, 'first'), apiError(500, 'second'), apiError(500, 'third')]);
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const pending = claim('pool-1', { api_token: 'token' });
    const rejection = expect(pending).rejects.toMatchObject({ error: { message: 'third' } });
    await vi.advanceTimersByTimeAsync(3_000);
    await rejection;

    expect(calls).toHaveLength(3);
  });

  it('fails fast on client errors without retrying', async () => {
    const { fetch, calls } = fakeFetch([apiError(404, 'pool not found')]);
    vi.stubGlobal('fetch', fetch);

    await expect(claim('pool-1', { api_token: 'token' })).rejects.toMatchObject({
      error: { message: 'pool not found' },
    });
    expect(calls).toHaveLength(1);
  });

  it('does not retry network-level failures, matching the Python reference', async () => {
    const { fetch, calls } = fakeFetch([new TypeError('fetch failed'), claimReply()]);
    vi.stubGlobal('fetch', fetch);

    await expect(claim('pool-1', { api_token: 'token' })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
  });

  it('honors max_attempts: a 429-storm stops at the configured budget', async () => {
    const { fetch, calls } = fakeFetch([apiError(429), apiError(429), claimReply()]);
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const pending = claim('pool-1', { api_token: 'token', max_attempts: 2 });
    const rejection = expect(pending).rejects.toMatchObject({ error: { message: 'boom' } });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    expect(calls).toHaveLength(2);
  });

  it('honors retry_delay: the backoff is retry_delay × attempt in seconds', async () => {
    const { fetch, calls } = fakeFetch([apiError(429), claimReply()]);
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const pending = claim('pool-1', { api_token: 'token', retry_delay: 5 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.service_id).toBe('svc-1');
    expect(calls).toHaveLength(2);
  });

  it('threads the host override to the claim endpoint', async () => {
    const { fetch, calls } = fakeFetch([claimReply()]);
    vi.stubGlobal('fetch', fetch);

    await claim('pool-1', { api_token: 'token', host: 'https://koyeb.example.org' });

    expect(calls[0].url.startsWith('https://koyeb.example.org/')).toBe(true);
  });

  it('retries on 429 rate limiting', async () => {
    const { fetch, calls } = fakeFetch([apiError(429), claimReply()]);
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const pending = claim('pool-1', { api_token: 'token' });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.service_id).toBe('svc-1');
    expect(calls).toHaveLength(2);
  });

  it('throws PoolClaimError when the reply has no service_id', async () => {
    const { fetch } = fakeFetch([jsonResponse({ claim_id: 'claim-1' })]);
    vi.stubGlobal('fetch', fetch);

    await expect(claim('pool-1', { api_token: 'token' })).rejects.toThrow(PoolClaimError);
  });

  it('throws PoolClaimError when the reply has no claim_id', async () => {
    const { fetch } = fakeFetch([jsonResponse({ service_id: 'svc-1' })]);
    vi.stubGlobal('fetch', fetch);

    await expect(claim('pool-1', { api_token: 'token' })).rejects.toThrow(PoolClaimError);
  });

  it('maps a warm claim (prewarmed true)', async () => {
    const { fetch } = fakeFetch([claimReply({ claim_id: 'claim-9', service_id: 'svc-9', prewarmed: true })]);
    vi.stubGlobal('fetch', fetch);

    const result = await claim('pool-1', { api_token: 'token' });

    expect(result.claim_id).toBe('claim-9');
    expect(result.service_id).toBe('svc-9');
    expect(result.prewarmed).toBe(true);
  });

  it('defaults prewarmed to false when the reply omits it', async () => {
    const { fetch } = fakeFetch([jsonResponse({ claim_id: 'claim-1', service_id: 'svc-1' })]);
    vi.stubGlobal('fetch', fetch);

    const result = await claim('pool-1', { api_token: 'token' });

    expect(result.prewarmed).toBe(false);
  });

  it('uses an explicit request_id verbatim (idempotent replay)', async () => {
    const { fetch, calls } = fakeFetch([claimReply()]);
    vi.stubGlobal('fetch', fetch);

    const result = await claim('pool-1', { api_token: 'token', request_id: 'req-42' });

    expect(result.request_id).toBe('req-42');
    expect(calls[0].body).toEqual({ pool_id: 'pool-1', request_id: 'req-42' });
  });

  it('requires an API token', async () => {
    vi.stubEnv('KOYEB_API_TOKEN', '');

    await expect(claim('pool-1')).rejects.toThrow(MissingApiTokenError);
  });
});

describe('get_claim', () => {
  it('fetches the claim resource by id', async () => {
    const { fetch, calls } = fakeFetch([jsonResponse({ claim: { id: 'claim-1', status: 'FULFILLED' } })]);
    vi.stubGlobal('fetch', fetch);

    const result = await get_claim('claim-1', { api_token: 'token' });

    expect(result.status).toBe('FULFILLED');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toMatch(/\/v1\/claims\/claim-1$/);
  });

  it('requires an API token', async () => {
    vi.stubEnv('KOYEB_API_TOKEN', '');

    await expect(get_claim('claim-1')).rejects.toThrow(MissingApiTokenError);
  });
});

describe('wait_claim_ready', () => {
  it('uses the dedicated 2s claim poll interval, not the sandbox default', () => {
    // Python keeps claim polling at 2.0s even though sandbox readiness polls at 0.5s.
    expect(DEFAULT_CLAIM_POLL_INTERVAL).toBe(2);
  });

  it('resolves true once the service is HEALTHY', async () => {
    const { fetch, calls } = fakeFetch([serviceReply('HEALTHY')]);
    vi.stubGlobal('fetch', fetch);

    const ready = await wait_claim_ready(claim_result, { api_token: 'token', poll_interval: 0.01 });

    expect(ready).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toMatch(/\/v1\/services\/svc-1$/);
  });

  it('resolves true on DEGRADED (still usable)', async () => {
    const { fetch } = fakeFetch([serviceReply('DEGRADED')]);
    vi.stubGlobal('fetch', fetch);

    const ready = await wait_claim_ready('svc-1', { api_token: 'token', poll_interval: 0.01 });

    expect(ready).toBe(true);
  });

  it.each(['UNHEALTHY', 'DELETING', 'DELETED', 'PAUSING', 'PAUSED'])(
    'throws ServiceTerminalStateError on %s',
    async (status: string) => {
      const { fetch } = fakeFetch([serviceReply(status)]);
      vi.stubGlobal('fetch', fetch);

      await expect(wait_claim_ready('svc-1', { api_token: 'token', poll_interval: 0.01 })).rejects.toThrow(
        ServiceTerminalStateError,
      );
    },
  );

  it('fails closed on unknown statuses', async () => {
    const { fetch } = fakeFetch([serviceReply('SOMETHING_NEW')]);
    vi.stubGlobal('fetch', fetch);

    await expect(wait_claim_ready('svc-1', { api_token: 'token', poll_interval: 0.01 })).rejects.toMatchObject({
      service_id: 'svc-1',
      status: 'SOMETHING_NEW',
    });
  });

  it('keeps polling when the service has no status yet', async () => {
    const { fetch, calls } = fakeFetch([serviceReply(undefined), serviceReply('HEALTHY')]);
    vi.stubGlobal('fetch', fetch);

    const ready = await wait_claim_ready('svc-1', { api_token: 'token', poll_interval: 0.01 });

    expect(ready).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('polls through in-progress statuses until ready', async () => {
    const { fetch, calls } = fakeFetch([serviceReply('STARTING'), serviceReply('RESUMING'), serviceReply('HEALTHY')]);
    vi.stubGlobal('fetch', fetch);

    const ready = await wait_claim_ready('svc-1', { api_token: 'token', poll_interval: 0.01 });

    expect(ready).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('returns false when the service never becomes ready', async () => {
    const { fetch } = fakeFetch([serviceReply('STARTING')], { repeatLast: true });
    vi.stubGlobal('fetch', fetch);

    const ready = await wait_claim_ready('svc-1', { api_token: 'token', timeout: 0.1, poll_interval: 0.02 });

    expect(ready).toBe(false);
  });

  it('keeps polling when Get Service fails transiently', async () => {
    const { fetch, calls } = fakeFetch([apiError(503), serviceReply('HEALTHY')]);
    vi.stubGlobal('fetch', fetch);

    const ready = await wait_claim_ready('svc-1', { api_token: 'token', timeout: 5, poll_interval: 0.01 });

    expect(ready).toBe(true);
    expect(calls[0].url).toMatch(/\/v1\/services\/svc-1$/);
    expect(calls).toHaveLength(2);
  });

  it('stops waiting early when the signal is aborted', async () => {
    const { fetch } = fakeFetch([serviceReply('STARTING')], { repeatLast: true });
    vi.stubGlobal('fetch', fetch);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const start = Date.now();
    const ready = await wait_claim_ready('svc-1', {
      api_token: 'token',
      timeout: 1,
      poll_interval: 0.05,
      signal: controller.signal,
    });

    expect(ready).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('requires an API token', async () => {
    vi.stubEnv('KOYEB_API_TOKEN', '');

    await expect(wait_claim_ready('svc-1')).rejects.toThrow(MissingApiTokenError);
  });

  it('returns false without polling when the signal is already aborted', async () => {
    const { fetch, calls } = fakeFetch([serviceReply('HEALTHY')]);
    vi.stubGlobal('fetch', fetch);

    const ready = await wait_claim_ready('svc-1', {
      api_token: 'token',
      poll_interval: 0.01,
      signal: AbortSignal.abort(),
    });

    expect(ready).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
