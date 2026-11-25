import { afterEach, describe, expect, it, vi } from 'vitest';

import { KoyebApi } from './api.js';
import { SidecarError } from './errors.js';
import { Sandbox } from './sandbox.js';
import {
  SIDECARS_ENV,
  Sidecar,
  SidecarInfo,
  alignedDeleteAfter,
  parseSidecarsEnv,
  sidecarsEnvValue,
} from './sidecar.js';

/**
 * Pins the sidecar lifecycle: the KOYEB_SIDECARS env on the sandbox,
 * get_from_id finding sidecars again (exact names, never partial),
 * update_lifecycle keeping sidecars in step, and delete_after_inactivity_delay
 * being rejected with sidecars (mirrors the Python SDK's
 * test_sidecar_lifecycle).
 */

const T0 = '2026-11-23T12:00:00Z';

/** `seconds` after T0, as an ISO timestamp (the API sends strings). */
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1_000).toISOString();

/** The Python test's `_proxy`. */
function proxy(name = 'proxy', ports: number[] = [8080]): Sidecar {
  return new Sidecar({ name, image: 'mitmproxy/mitmproxy', ports });
}

/** A recorded update: service id, update_mask and the new delete_after_create. */
type Update = [id: string, updateMask: string | undefined, deleteAfterCreate: number | undefined];

afterEach(() => {
  vi.restoreAllMocks();
});

const toEnv = (source: Record<string, string>) => Object.entries(source).map(([key, value]) => ({ key, value }));

/** The env of a sandbox created with sidecars (the Python test's `_env`). */
function sidecarsEnv(...sidecars: Sidecar[]): Record<string, string> {
  return { SANDBOX_SECRET: 's', [SIDECARS_ENV]: sidecarsEnvValue(sidecars) };
}

/** A bare handle like Sandbox.list() returns: no cached sidecars and no
 *  knowledge of the deployment (the Python test's `_handle`). */
function handle(sidecars: SidecarInfo[] = []): Sandbox {
  const sandbox = new Sandbox('app-id', 'sb-id', 'sb', 's', 'tok');
  (sandbox as unknown as { _sidecars: SidecarInfo[] })._sidecars = sidecars;
  return sandbox;
}

/**
 * KoyebApi fake, the Python test's `_FakeApi`: a sandbox service whose
 * deployment carries `env`, WEB services in its app, and listServicesPage
 * slicing pages. Every service id defaults to sandbox 'sb-id'; created
 * services are named svc-1, svc-2, ... in creation order.
 */
function fakeApi({
  env = {},
  web = {},
  life_cycles = {},
  created = {},
}: {
  env?: Record<string, string>;
  web?: Record<string, string>;
  life_cycles?: Record<string, number>;
  created?: Record<string, string>;
} = {}) {
  const webEntries = Object.entries(web); // [name, id], in creation order
  const idToName = new Map(webEntries.map(([name, id]) => [id, name]));
  const updates: Update[] = [];
  const api = {
    updates,
    failUpdateFor: new Set<string>(),
    failList: { value: false },
  };

  const getService = vi.spyOn(KoyebApi.prototype, 'getService').mockImplementation((id: string) =>
    Promise.resolve({
      id,
      app_id: 'app-id',
      name: id === 'sb-id' ? 'sb' : (idToName.get(id) ?? ''),
      active_deployment_id: `dep-${id}`,
      latest_deployment_id: `dep-${id}`,
      created_at: created[id] ?? T0,
      life_cycle: { delete_after_create: life_cycles[id] },
    } as never),
  );

  const getDeployment = vi.spyOn(KoyebApi.prototype, 'getDeployment').mockImplementation((id: string) =>
    Promise.resolve({
      id,
      status: 'HEALTHY',
      definition: { name: 'sb', env: toEnv(env) },
    } as never),
  );

  const listServicesPage = vi.spyOn(KoyebApi.prototype, 'listServicesPage').mockImplementation((query) => {
    if (api.failList.value) {
      return Promise.reject(new Error('503'));
    }

    const offset = Number(query?.offset ?? 0);
    const limit = Number(query?.limit ?? 100);
    const services = webEntries.slice(offset, offset + limit).map(([name, id]) => ({
      id,
      app_id: 'app-id',
      name,
      active_deployment_id: `dep-${id}`,
      latest_deployment_id: `dep-${id}`,
    }));

    return Promise.resolve({ services, count: webEntries.length });
  });

  const updateService = vi.spyOn(KoyebApi.prototype, 'updateService').mockImplementation((id: string, body, query) => {
    if (api.failUpdateFor.has(id)) {
      return Promise.reject(new Error('boom'));
    }

    updates.push([id, query?.update_mask, body.life_cycle?.delete_after_create]);
    return Promise.resolve({ id, latest_deployment_id: `dep-${id}-2` } as never);
  });

  const createApp = vi.spyOn(KoyebApi.prototype, 'createApp').mockResolvedValue({ id: 'app-id' } as never);
  const deleteApp = vi.spyOn(KoyebApi.prototype, 'deleteApp').mockResolvedValue({ id: 'app-id' } as never);

  let createdCount = 0;
  const createService = vi.spyOn(KoyebApi.prototype, 'createService').mockImplementation(() => {
    createdCount += 1;
    return Promise.resolve({ id: `svc-${createdCount}`, app_id: 'app-id' } as never);
  });

  return { ...api, getService, getDeployment, listServicesPage, updateService, createApp, deleteApp, createService };
}

describe('sidecarsEnvValue and parseSidecarsEnv', () => {
  it('round-trips names and ports as compact JSON', () => {
    const value = sidecarsEnvValue([proxy(), proxy('db', [5432, 5433])]);

    expect(value).toBe('[{"name":"proxy","ports":[8080]},{"name":"db","ports":[5432,5433]}]');
    expect(parseSidecarsEnv(value)).toEqual([
      { name: 'proxy', ports: [8080] },
      { name: 'db', ports: [5432, 5433] },
    ]);
  });

  it('returns nothing when unset', () => {
    expect(parseSidecarsEnv(undefined)).toEqual([]);
    expect(parseSidecarsEnv('')).toEqual([]);
  });

  it('raises on damaged values', () => {
    const damaged = [
      'nope',
      '[1]',
      '{"name":"a"}',
      '[{"name":"proxy"}]',
      '[{"name":"proxy","ports":[]}]',
      '[{"name":"proxy","ports":[1e309]}]',
      '[{"name":"proxy","ports":["80"]}]',
      '[{"name":"Bad","ports":[80]}]',
      '[{"name":"proxy","ports":[80]},{"name":"proxy","ports":[81]}]',
    ];

    for (const value of damaged) {
      expect(() => parseSidecarsEnv(value)).toThrow(SidecarError);
    }
  });
});

describe('alignedDeleteAfter', () => {
  it('adds the creation gap', () => {
    expect(alignedDeleteAfter(600, at(90), T0)).toBe(690);
  });

  it('rounds the gap up', () => {
    expect(alignedDeleteAfter(600, at(1.2), T0)).toBe(602);
  });

  it('keeps no-expiry and falls back to the delay on unknown times', () => {
    expect(alignedDeleteAfter(0, T0, T0)).toBe(0);
    expect(alignedDeleteAfter(600, undefined, T0)).toBe(600);
    expect(alignedDeleteAfter(600, T0, undefined)).toBe(600);
    // A sidecar created after its sandbox: no time is taken off the delay.
    expect(alignedDeleteAfter(600, T0, at(5))).toBe(600);
  });
});

describe('Sandbox.create sets KOYEB_SIDECARS', () => {
  it("lists the sidecars on the sandbox's env, not the sidecars'", async () => {
    const mocks = fakeApi();

    await Sandbox.create({
      api_token: 'token',
      name: 'sb',
      wait_ready: false,
      env: { A: '1' },
      sidecars: [proxy()],
    });

    const bodies = mocks.createService.mock.calls.map(([body]) => body);
    const envOf = (type: string) =>
      Object.fromEntries(
        (bodies.map((body) => body.definition).find((definition) => definition?.type === type)?.env ?? []).map(
          ({ key, value }) => [key, value],
        ),
      );

    expect(JSON.parse(envOf('SANDBOX')[SIDECARS_ENV])).toEqual([{ name: 'proxy', ports: [8080] }]);
    expect(envOf('SANDBOX').A).toBe('1');
    expect(envOf('WEB')[SIDECARS_ENV]).toBeUndefined();
    // Sidecars never sleep, so only delete_after_create applies to them.
    expect(bodies[0].life_cycle?.delete_after_sleep).toBe(0);
  });

  it('rejects a reserved KOYEB_SIDECARS env, even without sidecars', async () => {
    for (const sidecars of [undefined, [], [proxy()]] as (Sidecar[] | undefined)[]) {
      const mocks = fakeApi();

      await expect(
        Sandbox.create({ api_token: 'token', name: 'sb', sidecars, env: { [SIDECARS_ENV]: 'x' } }),
      ).rejects.toThrow(SidecarError);

      expect(mocks.createApp).not.toHaveBeenCalled();
    }
  });

  it('rejects delete_after_inactivity_delay with sidecars before any API call', async () => {
    const mocks = fakeApi();

    await expect(
      Sandbox.create({
        api_token: 'token',
        name: 'sb',
        sidecars: [proxy()],
        delete_after_inactivity_delay: 300,
      }),
    ).rejects.toThrow(SidecarError);

    expect(mocks.createApp).not.toHaveBeenCalled();
  });
});

describe('Sandbox.get_from_id finds sidecars', () => {
  it('matches exact names despite substring matches', async () => {
    // Older services whose names contain the sidecar names come first.
    const mocks = fakeApi({
      env: sidecarsEnv(proxy('db', [5432]), proxy()),
      web: { 'redis-db': 'svc-redis', 'proxy-admin': 'svc-admin', db: 'svc-db', proxy: 'svc-proxy' },
    });

    const sb = await Sandbox.get_from_id('sb-id', 'token');

    expect(sb.sidecars).toEqual([
      new SidecarInfo('db', 'svc-db', [5432]),
      new SidecarInfo('proxy', 'svc-proxy', [8080]),
    ]);

    for (const [query] of mocks.listServicesPage.mock.calls) {
      expect(query.app_id).toBe('app-id');
      expect(query.types).toEqual(['WEB']);
      expect(query.name).toBeUndefined();
    }
  });

  it('looks nothing up when the sandbox has no sidecars', async () => {
    const mocks = fakeApi({ env: { SANDBOX_SECRET: 's' } });

    const sb = await Sandbox.get_from_id('sb-id', 'token');

    expect(sb.sidecars).toEqual([]);
    expect(mocks.listServicesPage).not.toHaveBeenCalled();
  });

  it('raises when a listed sidecar has no service', async () => {
    fakeApi({ env: sidecarsEnv(proxy()), web: { 'proxy-admin': 'svc-admin' } });

    await expect(Sandbox.get_from_id('sb-id', 'token')).rejects.toThrow(SidecarError);
  });

  it('raises when the app services cannot be listed', async () => {
    const mocks = fakeApi({ env: sidecarsEnv(proxy()), web: { proxy: 'svc-proxy' } });
    mocks.failList.value = true;

    await expect(Sandbox.get_from_id('sb-id', 'token')).rejects.toThrow(SidecarError);
  });

  it('raises on a damaged KOYEB_SIDECARS value', async () => {
    fakeApi({ env: { SANDBOX_SECRET: 's', [SIDECARS_ENV]: '[{}]' } });

    await expect(Sandbox.get_from_id('sb-id', 'token')).rejects.toThrow(SidecarError);
  });

  it('paginates the app services', async () => {
    const web: Record<string, string> = {};
    for (let i = 0; i < 150; i += 1) {
      web[`svc${String(i).padStart(3, '0')}`] = `id-${i}`;
    }
    web.proxy = 'svc-proxy';

    const mocks = fakeApi({ env: sidecarsEnv(proxy()), web });
    const sb = await Sandbox.get_from_id('sb-id', 'token');

    expect(sb.sidecar('proxy').service_id).toBe('svc-proxy');
    expect(mocks.listServicesPage).toHaveBeenCalledTimes(2);
  });
});

describe('Sandbox.update_lifecycle with sidecars', () => {
  function lifecycleApi(options: { life_cycles?: Record<string, number>; created?: Record<string, string> } = {}) {
    return fakeApi({
      env: sidecarsEnv(proxy(), proxy('db', [5432])),
      web: { proxy: 'svc-proxy', db: 'svc-db' },
      ...options,
    });
  }

  it('updates the sidecars first, aligned and masked, then the sandbox', async () => {
    const mocks = lifecycleApi({ created: { 'svc-proxy': T0, 'svc-db': at(10), 'sb-id': at(90) } });

    await handle().update_lifecycle({ delete_after_delay: 900 });

    expect(mocks.updates).toEqual([
      ['svc-proxy', 'life_cycle.delete_after_create', 990],
      ['svc-db', 'life_cycle.delete_after_create', 980],
      ['sb-id', undefined, 900],
    ]);
  });

  it('updates the sidecars of a list() handle with nothing cached', async () => {
    const mocks = lifecycleApi();
    const sb = handle();

    await sb.update_lifecycle({ delete_after_delay: 900 });

    expect(mocks.updates.map(([id]) => id)).toEqual(['svc-proxy', 'svc-db', 'sb-id']);
    expect(sb.sidecars.map(({ name }) => name)).toEqual(['proxy', 'db']);
  });

  it('rejects delete_after_inactivity_delay read from the live deployment', async () => {
    const mocks = lifecycleApi();

    await expect(handle().update_lifecycle({ delete_after_inactivity_delay: 300 })).rejects.toThrow(SidecarError);
    expect(mocks.updates).toEqual([]);
  });

  it('skips sidecars whose delay is already set', async () => {
    const mocks = lifecycleApi({ life_cycles: { 'svc-proxy': 900 } });

    await handle().update_lifecycle({ delete_after_delay: 900 });

    expect(mocks.updates.map(([id]) => id)).toEqual(['svc-db', 'sb-id']);
  });

  it('changes nothing on the sandbox when a sidecar update fails', async () => {
    const mocks = lifecycleApi();
    mocks.failUpdateFor.add('svc-proxy');
    vi.spyOn(console, 'debug').mockImplementation(() => {});

    const error: unknown = await handle()
      .update_lifecycle({ delete_after_delay: 900 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SidecarError);
    expect((error as Error).message).toContain("'proxy'");
    expect((error as Error).message).toContain('Nothing was changed on the sandbox');
    expect(mocks.updates.map(([id]) => id)).toEqual(['svc-db']);
  });

  it('rejects delete_after_inactivity_delay known from the handle before any API call', async () => {
    const mocks = fakeApi();

    await expect(
      handle([new SidecarInfo('proxy', 'svc-proxy', [8080])]).update_lifecycle({ delete_after_inactivity_delay: 300 }),
    ).rejects.toThrow(SidecarError);

    expect(mocks.getService).not.toHaveBeenCalled();
  });

  it('allows delete_after_inactivity_delay: 0', async () => {
    const mocks = lifecycleApi();

    await handle().update_lifecycle({ delete_after_inactivity_delay: 0 });

    expect(mocks.updates.map(([id]) => id)).toEqual(['sb-id']);
  });

  it('is unchanged without sidecars', async () => {
    const mocks = fakeApi({ env: { SANDBOX_SECRET: 's' } });

    await handle().update_lifecycle({ delete_after_delay: 900, delete_after_inactivity_delay: 300 });

    expect(mocks.updates).toEqual([['sb-id', undefined, 900]]);
    expect(mocks.listServicesPage).not.toHaveBeenCalled();
  });
});

describe('Sandbox.create aligns sidecar expiry', () => {
  it("extends the sidecars' delay to the sandbox's creation", async () => {
    const mocks = fakeApi({
      web: { proxy: 'svc-1' },
      life_cycles: { 'svc-1': 600 },
      created: { 'svc-1': T0, 'svc-2': at(45) },
    });

    await Sandbox.create({
      api_token: 'token',
      name: 'sb',
      wait_ready: false,
      delete_after_delay: 600,
      sidecars: [proxy()],
    });

    expect(mocks.updates).toEqual([['svc-1', 'life_cycle.delete_after_create', 645]]);
  });

  it('does not fail create when the alignment fails', async () => {
    const mocks = fakeApi({ web: { proxy: 'svc-1' } });
    mocks.getService.mockRejectedValue(new Error('503'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sb = await Sandbox.create({
      api_token: 'token',
      name: 'sb',
      wait_ready: false,
      delete_after_delay: 600,
      sidecars: [proxy()],
    });

    expect(sb.sidecar('proxy').service_id).toBe('svc-1');
    expect(mocks.deleteApp).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('aligns nothing without a delay', async () => {
    const mocks = fakeApi({ web: { proxy: 'svc-1' } });

    await Sandbox.create({ api_token: 'token', name: 'sb', wait_ready: false, sidecars: [proxy()] });

    expect(mocks.updates).toEqual([]);
    expect(mocks.getService).not.toHaveBeenCalled();
  });
});

describe('Sandbox.update_network_policy on list() handles', () => {
  it('rejects egress read from the live deployment', async () => {
    const mocks = fakeApi({ env: sidecarsEnv(proxy()), web: { proxy: 'svc-proxy' } });

    for (const values of [{ block_network: true }, { outbound_allowlist: ['1.2.3.4'] }]) {
      await expect(handle().update_network_policy(values)).rejects.toThrow(SidecarError);
    }

    expect(mocks.updateService).not.toHaveBeenCalled();
  });

  it('still resets the egress policy to the default', async () => {
    const mocks = fakeApi({ env: sidecarsEnv(proxy()), web: { proxy: 'svc-proxy' } });

    await handle().update_network_policy();

    expect(mocks.updateService).toHaveBeenCalledTimes(1);
  });

  it('is unchanged without sidecars', async () => {
    const mocks = fakeApi({ env: { SANDBOX_SECRET: 's' } });

    await handle().update_network_policy({ block_network: true });

    expect(mocks.updateService).toHaveBeenCalledTimes(1);
  });
});
