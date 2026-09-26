import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServicePool } from './service-pool.js';
import { ServicePoolError } from './errors.js';
import { poolFetch } from './test-support.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ServicePool.create', () => {
  it('rejects DATABASE pools with a ServicePoolError before any API call', async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

    await expect(ServicePool.create('p', { type: 'DATABASE', api_token: 't' })).rejects.toBeInstanceOf(
      ServicePoolError,
    );
    expect(calls).toHaveLength(0);
  });

  it('threads the host override to the pool endpoints', async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

    await ServicePool.create('my-pool', { api_token: 't', host: 'https://koyeb.example.org' });

    expect(calls[0].url.startsWith('https://koyeb.example.org/')).toBe(true);
  });

  it('threads every definition option into the pool definition', async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

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

    const body = calls[0].body as {
      size: number;
      definition: {
        docker: { entrypoint?: string[]; command?: string; args?: string[] };
        scalings: { targets: { sleep_idle_delay: Record<string, number> }[] }[];
      };
    };

    expect(body.size).toBe(2);
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

  it("sends a WEB pool member's ports and routes verbatim with no sandbox wiring", async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

    await ServicePool.create('my-pool', {
      api_token: 't',
      type: 'WEB',
      ports: [{ port: 8080, protocol: 'http' }],
      routes: [{ port: 8080, path: '/' }],
    });

    const definition = calls[0].body.definition;
    expect(definition.ports).toEqual([{ port: 8080, protocol: 'http' }]);
    expect(definition.routes).toEqual([{ port: 8080, path: '/' }]);
    // No sandbox auto-wiring leaks into a WEB member.
    expect(definition.proxy_ports).toBeUndefined();
  });

  it('sends no ports or routes at all when a WEB member provides none', async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

    await ServicePool.create('my-pool', { api_token: 't', type: 'WORKER' });

    const definition = calls[0].body.definition;
    expect(definition.ports).toBeUndefined();
    expect(definition.routes).toBeUndefined();
  });

  it('rejects explicit ports or routes on SANDBOX pools before any API call', async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

    await expect(
      ServicePool.create('p', { api_token: 't', ports: [{ port: 8080, protocol: 'http' }] }),
    ).rejects.toBeInstanceOf(ServicePoolError);
    await expect(
      ServicePool.create('p', { api_token: 't', type: 'SANDBOX', routes: [{ port: 8080, path: '/' }] }),
    ).rejects.toBeInstanceOf(ServicePoolError);
    expect(calls).toHaveLength(0);
  });

  it('rejects sandbox-only wiring options on non-SANDBOX pools before any API call', async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

    await expect(
      ServicePool.create('p', { api_token: 't', type: 'WEB', exposed_port_protocol: 'http' }),
    ).rejects.toBeInstanceOf(ServicePoolError);
    await expect(
      ServicePool.create('p', { api_token: 't', type: 'WORKER', enable_tcp_proxy: true }),
    ).rejects.toBeInstanceOf(ServicePoolError);
    expect(calls).toHaveLength(0);
  });

  it('sends no SANDBOX_SECRET env on pool create: the platform mints it', async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

    await ServicePool.create('my-pool', { api_token: 't' });

    const definition = calls[0].body.definition;
    expect(definition.env?.some(({ key }: { key: string }) => key === 'SANDBOX_SECRET')).toBe(false);
  });

  it('passes an explicit caller-provided SANDBOX_SECRET through verbatim', async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

    await ServicePool.create('my-pool', {
      api_token: 't',
      env: { SANDBOX_SECRET: 'explicit-secret', OTHER: 'x' },
    });

    const definition = calls[0].body.definition;
    const secrets = definition.env.filter(({ key }: { key: string }) => key === 'SANDBOX_SECRET');
    expect(secrets).toEqual([{ key: 'SANDBOX_SECRET', value: 'explicit-secret' }]);
  });

  it('keeps the SANDBOX auto ports, routes, and AUTO mesh on SANDBOX pools', async () => {
    const { fetch, calls } = poolFetch();
    vi.stubGlobal('fetch', fetch);

    await ServicePool.create('my-pool', { api_token: 't' });

    const definition = calls[0].body.definition;
    expect(definition.ports.map(({ port }: { port: number }) => port)).toEqual([3030, 3031]);
    expect(definition.routes.map(({ port }: { port: number }) => port)).toEqual([3030, 3031]);
    expect(definition.mesh).toBe('DEPLOYMENT_MESH_AUTO');
  });

  it('exposes no pool-level mesh or secret options (compile-time)', () => {
    // Type-level only: the calls never execute. Mesh stays AUTO on pools and
    // secrets are platform-minted; neither is a pool option.
    if (false) {
      // @ts-expect-error enable_mesh is not a pool option
      void ServicePool.create('p', { enable_mesh: true });
      // @ts-expect-error sandbox_secret is not a pool option
      void ServicePool.create('p', { sandbox_secret: 'x' });
    }
  });
});
