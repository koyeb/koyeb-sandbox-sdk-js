import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveClient } from './credentials.js';
import { MissingApiTokenError } from './errors.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveClient', () => {
  it('fails fast without an explicit token or env token', () => {
    vi.stubEnv('KOYEB_API_TOKEN', '');

    expect(() => resolveClient()).toThrow(MissingApiTokenError);
  });

  it('prefers the explicit token over the env token', async () => {
    vi.stubEnv('KOYEB_API_TOKEN', 'env-token');
    const fetch = vi.fn(async (_request: Request) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const { token, client } = resolveClient({ api_token: 'explicit' });
    await client.getApp('app-1');

    expect(token).toBe('explicit');
    const request = fetch.mock.calls[0][0];
    expect(request.headers.get('Authorization')).toBe('Bearer explicit');
  });

  it('falls back to the env token', async () => {
    vi.stubEnv('KOYEB_API_TOKEN', 'env-token');
    const fetch = vi.fn(async (_request: Request) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const { token } = resolveClient();
    await resolveClient().client.getApp('app-1');

    expect(token).toBe('env-token');
    const request = fetch.mock.calls[0][0];
    expect(request.headers.get('Authorization')).toBe('Bearer env-token');
  });

  it('threads the host override into the client', async () => {
    vi.stubEnv('KOYEB_API_TOKEN', 't');
    const fetch = vi.fn(async (_request: Request) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await resolveClient({ host: 'https://koyeb.example.org' }).client.getApp('app-1');

    const request = fetch.mock.calls[0][0];
    expect(request.url.startsWith('https://koyeb.example.org/')).toBe(true);
  });
});
