import { afterEach, describe, expect, it, vi } from 'vitest';

import { KoyebApi } from './api.js';
import { ServicePoolError } from './errors.js';
import { ServicePool } from './service-pool.js';

function fetchStub(capture: { url?: string } = {}) {
  const fetch = vi.fn(async (request: Request) => {
    capture.url = request.url;
    return new Response(JSON.stringify({ service_pool: { id: 'pool-1', name: 'my-pool' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return capture;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ServicePool.create', () => {
  it('rejects DATABASE pools with a ServicePoolError before any API call', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(ServicePool.create('p', { type: 'DATABASE', api_token: 't' })).rejects.toBeInstanceOf(
      ServicePoolError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('threads the host override to the pool endpoints', async () => {
    const capture = fetchStub();

    await ServicePool.create('my-pool', { api_token: 't', host: 'https://koyeb.example.org' });

    expect(capture.url!.startsWith('https://koyeb.example.org/')).toBe(true);
  });

  it('threads every definition option into the pool definition', async () => {
    const create = vi.spyOn(KoyebApi.prototype, 'createServicePool').mockResolvedValue({
      id: 'pool-1',
      name: 'my-pool',
    } as never);

    await ServicePool.create('my-pool', {
      api_token: 't',
      size: 2,
      entrypoint: ['/bin/sh', '-c'],
      command: 'sleep 1',
      args: ['--flag'],
      idle_timeout: 60,
      _experimental_enable_light_sleep: true,
      _experimental_deep_sleep_value: 600,
    });

    const body = create.mock.calls[0][0] as {
      definition: {
        docker: { entrypoint?: string[]; command?: string; args?: string[] };
        env: { key: string; value: string }[];
        scalings: { targets: { sleep_idle_delay: Record<string, number> }[] }[];
      };
    };

    expect(body.definition.docker).toMatchObject({
      entrypoint: ['/bin/sh', '-c'],
      command: 'sleep 1',
      args: ['--flag'],
    });
    expect(body.definition.scalings[0].targets[0].sleep_idle_delay).toEqual({
      light_sleep_value: 60,
      deep_sleep_value: 600,
    });
  });

  it('sends a WEB pool member\'s ports and routes verbatim with no sandbox wiring', async () => {
    const create = vi.spyOn(KoyebApi.prototype, 'createServicePool').mockResolvedValue({
      id: 'pool-1',
      name: 'my-pool',
    } as never);

    await ServicePool.create('my-pool', {
      api_token: 't',
      type: 'WEB',
      ports: [{ port: 8080, protocol: 'http' }],
      routes: [{ port: 8080, path: '/' }],
    });

    const definition = (create.mock.calls[0][0] as { definition: Record<string, unknown> }).definition;
    expect(definition.ports).toEqual([{ port: 8080, protocol: 'http' }]);
    expect(definition.routes).toEqual([{ port: 8080, path: '/' }]);
    // No sandbox auto-wiring leaks into a WEB member.
    expect(definition.proxy_ports).toBeUndefined();
  });

  it('rejects explicit ports or routes on SANDBOX pools before any API call', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      ServicePool.create('p', { api_token: 't', ports: [{ port: 8080, protocol: 'http' }] }),
    ).rejects.toBeInstanceOf(ServicePoolError);
    await expect(
      ServicePool.create('p', { api_token: 't', type: 'SANDBOX', routes: [{ port: 8080, path: '/' }] }),
    ).rejects.toBeInstanceOf(ServicePoolError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects sandbox-only wiring options on non-SANDBOX pools before any API call', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      ServicePool.create('p', { api_token: 't', type: 'WEB', exposed_port_protocol: 'http' }),
    ).rejects.toBeInstanceOf(ServicePoolError);
    await expect(
      ServicePool.create('p', { api_token: 't', type: 'WORKER', enable_tcp_proxy: true }),
    ).rejects.toBeInstanceOf(ServicePoolError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exposes no pool-level mesh or secret options (compile-time)', () => {
    // Type-level only: the calls never execute. Mesh stays AUTO on pools and
    // secrets are platform-minted (KOYEB-6439); neither is a pool option.
    if (false) {
      // @ts-expect-error enable_mesh is not a pool option
      void ServicePool.create('p', { enable_mesh: true });
      // @ts-expect-error sandbox_secret is not a pool option
      void ServicePool.create('p', { sandbox_secret: 'x' });
    }
  });
});
