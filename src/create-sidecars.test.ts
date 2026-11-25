import { afterEach, describe, expect, it, vi } from 'vitest';

import { KoyebApi } from './api.js';
import { SandboxError, SandboxApiError, SandboxTimeoutError, SidecarError, SidecarTimeoutError } from './errors.js';
import { Sandbox } from './sandbox.js';
import { Sidecar, SidecarInfo } from './sidecar.js';

/**
 * Pins `Sandbox.create({ sidecars })`: argument checks before any API call, the
 * create order (sidecars, wait, sandbox), cleanup on failure, and that create
 * without sidecars is unchanged (mirrors the Python SDK's test_create_sidecars).
 */

type CreateServiceBody = Parameters<KoyebApi['createService']>[0];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The Python test's `_proxy`. */
function proxy(name = 'proxy', ports: number[] = [8080]): Sidecar {
  return new Sidecar({ name, image: 'mitmproxy/mitmproxy', ports });
}

/**
 * KoyebApi mock, the Python test's `_clients`: each created service gets an
 * id; deployments report the given statuses in turn (default HEALTHY).
 */
function clients(statuses?: string[]) {
  const createApp = vi.spyOn(KoyebApi.prototype, 'createApp').mockResolvedValue({ id: 'app-id' } as never);
  const deleteApp = vi.spyOn(KoyebApi.prototype, 'deleteApp').mockResolvedValue({ id: 'app-id' } as never);
  const created: CreateServiceBody[] = [];
  let n = 0;
  const createService = vi.spyOn(KoyebApi.prototype, 'createService').mockImplementation((body) => {
    n += 1;
    created.push(body);
    return Promise.resolve({ id: `svc-${n}`, app_id: 'app-id' } as never);
  });
  const getService = vi
    .spyOn(KoyebApi.prototype, 'getService')
    .mockResolvedValue({ latest_deployment_id: 'dep-1' } as never);
  const seq = [...(statuses ?? [])];
  const getDeployment = vi
    .spyOn(KoyebApi.prototype, 'getDeployment')
    .mockImplementation(() => Promise.resolve({ status: seq.length > 0 ? seq.shift() : 'HEALTHY' } as never));

  return { createApp, deleteApp, createService, getService, getDeployment, created };
}

describe('Sandbox.create without sidecars', () => {
  it.each([undefined, []])('is unchanged when sidecars is %p', async (sidecars) => {
    const mocks = clients();

    const sb = await Sandbox.create({ api_token: 'token', name: 'sb', wait_ready: false, sidecars });

    expect(mocks.createService).toHaveBeenCalledTimes(1);
    expect(mocks.created[0].definition?.network_policy).toBeUndefined();
    expect(sb.sidecars).toEqual([]);
  });
});

describe('Sandbox.create({ sidecars }) argument checks', () => {
  it('rejects every conflicting argument before any API call', async () => {
    const cases = [
      { app_id: 'app-123' },
      { snapshot: 'snap-1' },
      { block_network: true },
      { outbound_allowlist: ['1.2.3.4'] },
      { enable_mesh: false },
      { mesh_scope: 'MESH_SCOPE_WORKSPACE' as const },
    ];

    for (const conflict of cases) {
      const mocks = clients();

      await expect(
        Sandbox.create({ api_token: 'token', name: 'sb', sidecars: [proxy()], ...conflict }),
      ).rejects.toBeInstanceOf(SidecarError);

      expect(mocks.createApp).not.toHaveBeenCalled();
      expect(mocks.getService).not.toHaveBeenCalled();
    }
  });

  it('rejects duplicate sidecar names and a sidecar named like the sandbox', async () => {
    const mocks = clients();

    await expect(Sandbox.create({ api_token: 'token', name: 'sb', sidecars: [proxy(), proxy()] })).rejects.toThrow(
      /Duplicate sidecar name 'proxy'/,
    );
    await expect(Sandbox.create({ api_token: 'token', name: 'proxy', sidecars: [proxy()] })).rejects.toThrow(
      /is the sandbox's name/,
    );

    expect(mocks.createApp).not.toHaveBeenCalled();
  });

  it('accepts an explicit app scope and enable_mesh: true', async () => {
    const mocks = clients();

    await Sandbox.create({
      api_token: 'token',
      name: 'sb',
      wait_ready: false,
      sidecars: [proxy()],
      enable_mesh: true,
      mesh_scope: 'MESH_SCOPE_APP',
    });

    expect(mocks.createService).toHaveBeenCalledTimes(2);
  });

  it('treats mesh_scope MESH_SCOPE_UNSPECIFIED as the default', async () => {
    const mocks = clients();

    await Sandbox.create({
      api_token: 'token',
      name: 'sb',
      wait_ready: false,
      sidecars: [proxy()],
      mesh_scope: 'MESH_SCOPE_UNSPECIFIED',
    });

    expect(mocks.created[0].definition?.network_policy?.mesh?.scope).toBe('MESH_SCOPE_APP');
  });
});

describe('Sandbox.create with sidecars', () => {
  it('creates the sidecars then the sandbox, all in one app with the app-scoped mesh', async () => {
    const mocks = clients();

    const sb = await Sandbox.create({
      api_token: 'token',
      name: 'sb',
      region: 'fra',
      wait_ready: false,
      delete_after_delay: 600,
      sidecars: [proxy(), proxy('db', [5432])],
    });

    expect(mocks.createApp).toHaveBeenCalledTimes(1);
    const bodies = mocks.created;
    expect(bodies.map((body) => body.name ?? body.definition?.name)).toEqual(['proxy', 'db', 'sb']);

    for (const body of bodies) {
      expect(body.app_id).toBe('app-id');
      expect(body.definition?.network_policy?.mesh?.scope).toBe('MESH_SCOPE_APP');
      expect(body.definition?.mesh).toBe('DEPLOYMENT_MESH_ENABLED');
      expect(body.definition?.regions).toEqual(['fra']);
      expect(body.life_cycle?.delete_after_create).toBe(600);
    }

    expect(bodies[0].definition?.type).toBe('WEB');
    expect(bodies[0].name).toBe('proxy');
    expect(bodies[2].definition?.type).toBe('SANDBOX');

    expect(sb.sidecars.map(({ name }) => name)).toEqual(['proxy', 'db']);
    expect(sb.sidecar('db').service_id).toBe('svc-2');
    expect(sb.sidecar('proxy').url()).toBe('http://proxy:8080');
    expect(sb.sidecar('db').url(5432, 'postgres')).toBe('postgres://db:5432');
    expect(() => sb.sidecar('nope')).toThrow(SidecarError);
  });

  it('waits for the sidecars before creating the sandbox', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mocks = clients();
    const events: string[] = [];

    mocks.createService.mockImplementation((body) => {
      events.push(`create:${body.name ?? body.definition?.name}`);
      return Promise.resolve({ id: `svc-${body.name}`, app_id: 'app-id' } as never);
    });

    const statuses = ['STARTING', 'STARTING', 'HEALTHY'];
    mocks.getDeployment.mockImplementation(() => {
      events.push('poll');
      return Promise.resolve({ status: statuses.shift() ?? 'HEALTHY' } as never);
    });

    vi.spyOn(Sandbox.prototype, 'wait_ready').mockResolvedValue(true);

    const pending = Sandbox.create({ api_token: 'token', name: 'sb', sidecars: [proxy()] });
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    // The sidecar is created first, polled until healthy, then the sandbox.
    expect(events[0]).toBe('create:proxy');
    expect(events[1]).toBe('poll');
    expect(events.slice(1, 4)).toEqual(['poll', 'poll', 'poll']);
    expect(events[4]).toBe('create:sb');
  });

  it('deletes the app when a sidecar fails to start', async () => {
    const mocks = clients(['ERROR']);

    const error = await Sandbox.create({ api_token: 'token', name: 'sb', sidecars: [proxy()] }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SidecarError);
    expect((error as Error).message).toContain('app was deleted');
    expect(mocks.deleteApp).toHaveBeenCalledTimes(1);
    expect(mocks.deleteApp).toHaveBeenCalledWith('app-id');
    expect(mocks.created.map((body) => body.name)).toEqual(['proxy']);
  });

  it('keeps the app for inspection when cleanup_on_failure is false', async () => {
    const mocks = clients(['ERROR']);

    const error = await Sandbox.create({
      api_token: 'token',
      name: 'sb',
      sidecars: [proxy()],
      cleanup_on_failure: false,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SidecarError);
    expect((error as Error).message).toContain('kept for inspection');
    expect(mocks.deleteApp).not.toHaveBeenCalled();
  });

  it('times out when a sidecar never becomes healthy, deleting the app', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mocks = clients();
    mocks.getDeployment.mockImplementation(() => Promise.resolve({ status: 'STARTING' } as never));

    const pending = Sandbox.create({
      api_token: 'token',
      name: 'sb',
      sidecars: [proxy()],
      timeout: 50,
    }).catch((e: unknown) => e);
    // Past the deadline, so the failing poll runs once the clock crosses it.
    await vi.advanceTimersByTimeAsync(51_000);
    const error = await pending;

    expect(error).toBeInstanceOf(SidecarTimeoutError);
    expect((error as Error).message).toContain('did not become healthy within 50 seconds');
    expect(mocks.deleteApp).toHaveBeenCalledTimes(1);
    expect(mocks.deleteApp).toHaveBeenCalledWith('app-id');
  });

  it('deletes the app when creating a sidecar service fails', async () => {
    const mocks = clients();
    mocks.createService.mockRejectedValue(new SandboxApiError(400, { message: 'bad' }));

    const error = await Sandbox.create({ api_token: 'token', name: 'sb', sidecars: [proxy()] }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SidecarError);
    expect((error as Error).message).toContain("Failed to create sidecar 'proxy'");
    expect(mocks.deleteApp).toHaveBeenCalledTimes(1);
    expect(mocks.deleteApp).toHaveBeenCalledWith('app-id');
  });

  it('skips the sidecar poll when wait_ready is false', async () => {
    const mocks = clients();

    await Sandbox.create({ api_token: 'token', name: 'sb', wait_ready: false, sidecars: [proxy()] });

    expect(mocks.getDeployment).not.toHaveBeenCalled();
  });
});

describe('Sandbox.create({ sidecars }) failure recovery', () => {
  it('retries a transient sidecar poll failure until the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mocks = clients();
    let calls = 0;

    mocks.getDeployment.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new SandboxApiError(502, { message: 'bad gateway' }));
      }
      return Promise.resolve({ status: 'HEALTHY' } as never);
    });
    vi.spyOn(Sandbox.prototype, 'wait_ready').mockResolvedValue(true);

    const pending = Sandbox.create({ api_token: 'token', name: 'sb', sidecars: [proxy()] });
    await vi.advanceTimersByTimeAsync(500);
    const sb = await pending;

    expect(sb.sidecar('proxy').service_id).toBe('svc-1');
    expect(mocks.deleteApp).not.toHaveBeenCalled();
  });

  it('reports a failed app cleanup in the error', async () => {
    const mocks = clients(['ERROR']);
    mocks.deleteApp.mockRejectedValue(new SandboxApiError(503, { message: 'unavailable' }));

    const error = await Sandbox.create({ api_token: 'token', name: 'sb', sidecars: [proxy()] }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SidecarError);
    expect((error as Error).message).toContain('could not be deleted');
    expect((error as Error).message).toContain('app-id');
    expect((error as Error).message).not.toContain('app was deleted');
  });

  it('deletes the app when the second sidecar fails to create', async () => {
    const mocks = clients();
    const names: (string | undefined)[] = [];

    mocks.createService.mockImplementation((body) => {
      names.push(body.name);

      if (body.name === 'db') {
        return Promise.reject(new SandboxApiError(400, { message: 'bad' }));
      }

      return Promise.resolve({ id: `svc-${body.name}`, app_id: 'app-id' } as never);
    });

    const error = await Sandbox.create({
      api_token: 'token',
      name: 'sb',
      sidecars: [proxy(), proxy('db', [5432])],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SidecarError);
    expect((error as Error).message).toContain("'db'");
    expect((error as Error).message).toContain('app was deleted');
    expect(names).toEqual(['proxy', 'db']);
    expect(mocks.deleteApp).toHaveBeenCalledTimes(1);
  });

  it('deletes the app when the sandbox service fails to create after the sidecars', async () => {
    const mocks = clients();

    mocks.createService.mockImplementation((body) => {
      if (body.definition?.type === 'SANDBOX') {
        return Promise.reject(new SandboxApiError(400, { message: 'quota' }));
      }

      return Promise.resolve({ id: `svc-${body.name}`, app_id: 'app-id' } as never);
    });

    const error = await Sandbox.create({ api_token: 'token', name: 'sb', sidecars: [proxy()] }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SandboxError);
    expect((error as Error).message).toContain('app was deleted');
    expect(mocks.deleteApp).toHaveBeenCalledTimes(1);
  });

  it('raises a SidecarTimeoutError that is both a SandboxTimeoutError and a SidecarError', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    clients();
    vi.spyOn(KoyebApi.prototype, 'getDeployment').mockImplementation(() =>
      Promise.resolve({ status: 'STARTING' } as never),
    );

    const pending = Sandbox.create({
      api_token: 'token',
      name: 'sb',
      sidecars: [proxy()],
      timeout: 50,
    }).catch((e: unknown) => e);
    // Past the deadline, so the failing poll runs once the clock crosses it.
    await vi.advanceTimersByTimeAsync(51_000);
    const error = await pending;

    expect(error).toBeInstanceOf(SandboxTimeoutError);
    expect(error).toBeInstanceOf(SidecarTimeoutError);
    expect(error).toBeInstanceOf(SidecarError);
  });

  it('shares one deadline between the sidecar wait and the sandbox readiness wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const mocks = clients();
    let start: number | undefined;

    mocks.getDeployment.mockImplementation(() => {
      start ??= Date.now();
      return Promise.resolve({ status: Date.now() - start < 40_000 ? 'STARTING' : 'HEALTHY' } as never);
    });

    const seen: number[] = [];
    vi.spyOn(Sandbox.prototype, 'wait_ready').mockImplementation(async (timeout?: number) => {
      seen.push(timeout!);
      return true;
    });

    const pending = Sandbox.create({ api_token: 'token', name: 'sb', sidecars: [proxy()], timeout: 60 });
    await vi.advanceTimersByTimeAsync(45_000);
    await pending;

    // The sidecar wait consumed ~40 s of the 60 s deadline.
    expect(seen[0]).toBeGreaterThan(19);
    expect(seen[0]).toBeLessThanOrEqual(20.01);
  });

  it('gives the sandbox readiness wait the full timeout without sidecars', async () => {
    clients();

    const seen: number[] = [];
    vi.spyOn(Sandbox.prototype, 'wait_ready').mockImplementation(async (timeout?: number) => {
      seen.push(timeout!);
      return true;
    });

    await Sandbox.create({ api_token: 'token', name: 'sb', timeout: 60 });

    expect(seen[0]).toBe(60);
  });
});

describe('Sandbox.update_network_policy with sidecars', () => {
  function sandboxWithSidecar() {
    const sandbox = new Sandbox('app-1', 'svc-1', 'sb', 'secret-1', 'token');
    (sandbox as unknown as { _sidecars: SidecarInfo[] })._sidecars = [new SidecarInfo('proxy', 'svc-proxy', [8080])];
    return sandbox;
  }

  it('rejects egress that would cut the sandbox off from its sidecars', async () => {
    const getService = vi.spyOn(KoyebApi.prototype, 'getService');

    for (const values of [{ block_network: true }, { outbound_allowlist: ['1.2.3.4'] }]) {
      await expect(sandboxWithSidecar().update_network_policy(values)).rejects.toThrow(SidecarError);
    }

    expect(getService).not.toHaveBeenCalled();
  });
});

describe('SidecarInfo', () => {
  it('freezes the ports and checks the url port', () => {
    const info = new SidecarInfo('proxy', 'svc', [8080, 9090]);

    expect(info.ports).toEqual([8080, 9090]);
    expect(info.url(9090)).toBe('http://proxy:9090');
    expect(() => info.url(8081)).toThrow(/doesn't declare port 8081/);
    expect(() => (info.ports as number[]).push(1)).toThrow(TypeError);
  });

  it('urls the first port by default', () => {
    expect(new SidecarInfo('proxy', 'svc', [8080]).url()).toBe('http://proxy:8080');
  });
});
