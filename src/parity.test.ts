import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KoyebApi, koyeb } from './api.js';
import { DEFAULT_INSTANCE_WAIT_TIMEOUT, DEFAULT_POLL_INTERVAL } from './constants.js';
import {
  EgressPolicyError,
  SandboxApiError,
  InvalidPortError,
  MissingApiTokenError,
  NoSandboxSecretError,
  PoolClaimError,
  SandboxCommandError,
  SandboxDeploymentError,
  SandboxError,
  SandboxFileExistsError,
  SandboxFileNotFoundError,
  SandboxFilesystemError,
  SandboxRequestError,
  SandboxTimeoutError,
  ServicePoolError,
  ServiceTerminalStateError,
} from './errors.js';
import { Sandbox } from './sandbox.js';
import { completeEvent, sseResponse } from './test-support.js';
import { buildDefinition, shellQuote } from './utils.js';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '22222222-2222-4222-8222-222222222222';
const DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('constants parity with the Python SDK', () => {
  it('readiness polls default to the Python 0.5s steady interval', () => {
    expect(DEFAULT_POLL_INTERVAL).toBe(0.5);
  });

  it('standalone readiness waits default to the Python 60s timeout', () => {
    expect(DEFAULT_INSTANCE_WAIT_TIMEOUT).toBe(60);
  });
});

describe('error taxonomy parity with the Python SDK', () => {
  it('all SDK errors share the SandboxError base', () => {
    const errors = [
      new MissingApiTokenError(),
      new InvalidPortError(1),
      new SandboxTimeoutError('name', 1),
      new NoSandboxSecretError(),
      new SandboxCommandError({ command: 'x', stdout: '', stderr: '', code: 1 }),
      new SandboxRequestError(418, {}),
      new EgressPolicyError('x'),
      new PoolClaimError('x'),
      new ServiceTerminalStateError('id', 'UNHEALTHY'),
      new ServicePoolError('x'),
      new SandboxFilesystemError('x'),
      new SandboxFileNotFoundError('x'),
      new SandboxFileExistsError('x'),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(SandboxError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('filesystem errors form a hierarchy', () => {
    expect(new SandboxFileNotFoundError('x')).toBeInstanceOf(SandboxFilesystemError);
    expect(new SandboxFileExistsError('x')).toBeInstanceOf(SandboxFilesystemError);
  });
});

describe('shellQuote', () => {
  it('wraps ordinary paths without changing them', () => {
    expect(shellQuote('/data/file.txt')).toBe("'/data/file.txt'");
  });

  it('neutralizes shell metacharacters', () => {
    const malicious = '/tmp/a b; rm -rf /';
    expect(shellQuote(malicious)).toBe("'/tmp/a b; rm -rf /'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('filesystem fallbacks escape paths', () => {
  const sandbox = new Sandbox(APP_ID, SERVICE_ID, 'sbx', 'secret', 'token');
  const fetch = vi.fn();

  beforeEach(() => {
    fetch.mockReset();
    fetch.mockImplementation(async () => sseResponse([completeEvent({ code: 0, error: false })]));
    vi.spyOn(sandbox, 'fetch').mockImplementation(fetch as never);
  });

  it('rm quotes the path', async () => {
    await sandbox.filesystem.rm('/tmp/a b; touch /tmp/pwned');

    const cmd = fetch.mock.calls[0][2]!.cmd as string;
    expect(cmd).toBe(`rm '/tmp/a b; touch /tmp/pwned'`);
  });

  it('rename_file quotes both paths', async () => {
    await sandbox.filesystem.rename_file('/tmp/a b', '/tmp/c; rm -rf /');

    const cmd = fetch.mock.calls[0][2]!.cmd as string;
    expect(cmd).toBe(`mv '/tmp/a b' '/tmp/c; rm -rf /'`);
  });

  it('recursive rm adds -rf before the quoted path', async () => {
    await sandbox.filesystem.rm('/tmp/x; rm -rf /', true);

    const cmd = fetch.mock.calls[0][2]!.cmd as string;
    expect(cmd).toBe(`rm -rf '/tmp/x; rm -rf /'`);
  });

  it('exists/is_file/is_dir quote the path', async () => {
    await sandbox.filesystem.exists('/tmp/a b');
    await sandbox.filesystem.is_file('/tmp/a b');
    await sandbox.filesystem.is_dir('/tmp/a b');

    const cmds = fetch.mock.calls.map((call) => (call[2] as { cmd: string }).cmd);
    expect(cmds).toEqual([
      `test -e '/tmp/a b'`,
      `test -f '/tmp/a b'`,
      `test -d '/tmp/a b'`,
    ]);
  });
});

describe('filesystem executor error mapping', () => {
  const sandbox = new Sandbox(APP_ID, SERVICE_ID, 'sbx', 'secret', 'token');
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    vi.spyOn(sandbox as never, 'request').mockImplementation(request as never);
  });

  it('maps the executor\'s raw error strings to SandboxFileNotFoundError', async () => {
    request.mockResolvedValue({ error: 'open /data/missing: no such file or directory' });

    await expect(sandbox.filesystem.read_file('/data/missing')).rejects.toBeInstanceOf(SandboxFileNotFoundError);
  });

  it('maps file-exists errors to SandboxFileExistsError', async () => {
    request.mockResolvedValue({ error: 'mkdir /data/already: file exists' });

    await expect(sandbox.filesystem.mkdir('/data/already')).rejects.toBeInstanceOf(SandboxFileExistsError);
  });

  it('wraps unknown executor errors in SandboxFilesystemError', async () => {
    request.mockResolvedValue({ error: 'DISK_FULL: /data' });

    await expect(sandbox.filesystem.write_file('/data/x', 'y')).rejects.toBeInstanceOf(SandboxFilesystemError);
    await expect(sandbox.filesystem.write_file('/data/x', 'y')).rejects.not.toBeInstanceOf(SandboxFileNotFoundError);
  });

  it('leaves successful responses untouched', async () => {
    request.mockResolvedValue({ content: 'hello', encoding: 'utf-8' });

    await expect(sandbox.filesystem.read_file('/data/x')).resolves.toEqual({
      content: 'hello',
      encoding: 'utf-8',
    });
  });
});

describe('buildDefinition parity options', () => {
  it('passes entrypoint/command/args to the docker source', () => {
    const { definition } = buildDefinition({
      name: 'sbx',
      image: 'alpine',
      entrypoint: ['/bin/sh', '-c'],
      command: 'sleep 1',
      args: ['--flag', 'value'],
    });

    expect(definition.docker?.entrypoint).toEqual(['/bin/sh', '-c']);
    expect(definition.docker?.command).toBe('sleep 1');
    expect(definition.docker?.args).toEqual(['--flag', 'value']);
  });

  it('maps enable_mesh like the Python SDK', () => {
    // Python always sends the field: unset means AUTO.
    expect(buildDefinition({ name: 'sbx', enable_mesh: undefined }).definition.mesh).toBe('DEPLOYMENT_MESH_AUTO');

    expect(buildDefinition({ name: 'sbx', enable_mesh: true }).definition.mesh).toBe('DEPLOYMENT_MESH_ENABLED');
    expect(buildDefinition({ name: 'sbx', enable_mesh: false }).definition.mesh).toBe('DEPLOYMENT_MESH_DISABLED');
  });

  it('honors an explicit sandbox_secret', () => {
    const { definition, sandbox_secret } = buildDefinition({ name: 'sbx', sandbox_secret: 'given-secret' });

    expect(sandbox_secret).toBe('given-secret');
    expect(definition.env?.[0]).toEqual({ key: 'SANDBOX_SECRET', value: 'given-secret' });
  });

  it('uses the deep sleep override when light sleep is enabled', () => {
    const { definition } = buildDefinition({
      name: 'sbx',
      idle_timeout: 60,
      _experimental_enable_light_sleep: true,
      _experimental_deep_sleep_value: 600,
    });

    expect(definition.scalings?.[0]?.targets?.[0]?.sleep_idle_delay).toEqual({
      light_sleep_value: 60,
      deep_sleep_value: 600,
    });
  });
});

function stubControlPlane(handlers: {
  service?: koyeb.Service;
  deployment?: koyeb.Deployment;
  app?: koyeb.App;
  health?: () => Response;
  serviceCreate?: () => Response;
}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const service = handlers.service ?? {
    id: SERVICE_ID,
    app_id: APP_ID,
    name: 'sbx',
    status: 'HEALTHY' as const,
    active_deployment_id: DEPLOYMENT_ID,
    latest_deployment_id: DEPLOYMENT_ID,
  };
  const deployment =
    handlers.deployment ??
    ({
      id: DEPLOYMENT_ID,
      status: 'HEALTHY' as const,
      definition: { env: [{ key: 'SANDBOX_SECRET', value: 'secret' }] },
      metadata: { sandbox: { public_url: 'https://sbx.example.org', routing_key: 'rk' } },
    } as koyeb.Deployment);

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = await request.clone().text();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: request.method, url: request.url, body });

    if (url.pathname === '/v1/apps' && request.method === 'POST') {
      return jsonResponse({ app: handlers.app ?? { id: APP_ID, name: 'app' } });
    }
    if (url.pathname === `/v1/apps/${APP_ID}` && request.method === 'DELETE') {
      return jsonResponse({ app: {} });
    }
    if (url.pathname === `/v1/apps/${APP_ID}`) {
      return jsonResponse({ app: handlers.app ?? { id: APP_ID, name: 'app', domains: [{ name: 'app.example.org' }] } });
    }
    if (url.pathname === '/v1/services' && request.method === 'POST') {
      if (handlers.serviceCreate) {
        return handlers.serviceCreate();
      }
      return jsonResponse({ service: { id: SERVICE_ID, app_id: (body as { app_id: string }).app_id, name: 'sbx' } });
    }
    if (url.pathname === `/v1/services/${SERVICE_ID}` && request.method === 'DELETE') {
      return jsonResponse({ service: {} });
    }
    if (url.pathname === `/v1/services/${SERVICE_ID}`) {
      return jsonResponse({ service });
    }
    if (url.pathname.startsWith('/v1/deployments/')) {
      return jsonResponse({ deployment });
    }
    if (url.pathname.endsWith('/health')) {
      return handlers.health?.() ?? new Response('OK', { status: 200 });
    }
    return jsonResponse({}, 404);
  });

  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}

describe('update_network_policy parity (reference commit 10210e3)', () => {
  const OLD_DEPLOYMENT = 'dep-old';
  const NEW_DEPLOYMENT = 'dep-new';

  function stubPolicyApi(overrides: {
    updateResponse?: () => Promise<unknown>;
    postUpdateService?: () => Promise<unknown>;
  } = {}) {
    const sandbox = new Sandbox(APP_ID, SERVICE_ID, 'sbx', 'sec', 'token');
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    let updated = false;

    vi.spyOn(api, 'getService').mockImplementation(async () => {
      if (!updated) {
        return { active_deployment_id: OLD_DEPLOYMENT, latest_deployment_id: OLD_DEPLOYMENT } as never;
      }
      return (
        overrides.postUpdateService
          ? await overrides.postUpdateService()
          : { active_deployment_id: OLD_DEPLOYMENT, latest_deployment_id: NEW_DEPLOYMENT }
      ) as never;
    });
    vi.spyOn(api, 'getDeployment').mockResolvedValue({ status: 'HEALTHY' } as never);
    vi.spyOn(api, 'updateService').mockImplementation(async () => {
      updated = true;
      return (
        overrides.updateResponse ? await overrides.updateResponse() : { latest_deployment_id: NEW_DEPLOYMENT }
      ) as never;
    });

    return { sandbox, api };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins the replacement deployment so wait_ready polls it, not the old active one', async () => {
    const { sandbox, api } = stubPolicyApi();

    await sandbox.update_network_policy({ block_network: true });
    vi.mocked(api.getDeployment).mockClear();
    await sandbox.wait_ready(0.1, 0.02);

    const polled = vi.mocked(api.getDeployment).mock.calls.map((call) => call[0]);
    expect(polled).toContain(NEW_DEPLOYMENT);
    expect(polled).not.toContain(OLD_DEPLOYMENT);
  });

  it('falls back to a fresh service lookup when the update response has no id', async () => {
    const { sandbox, api } = stubPolicyApi({ updateResponse: async () => ({}) });

    await sandbox.update_network_policy({ block_network: true });
    vi.mocked(api.getDeployment).mockClear();
    await sandbox.wait_ready(0.1, 0.02);

    // The fallback getService supplied the new deployment id.
    expect(vi.mocked(api.getDeployment).mock.calls.map((call) => call[0])).toContain(NEW_DEPLOYMENT);
  });

  it('resolves the update when the id lookup fails, resetting the pin', async () => {
    const { sandbox, api } = stubPolicyApi({
      updateResponse: async () => ({}),
      postUpdateService: async () => {
        throw new Error('lookup blew up after the update');
      },
    });
    const getServiceCallsAfterUpdate = () => vi.mocked(api.getService).mock.calls.length;

    await expect(sandbox.update_network_policy({ block_network: true })).resolves.toBeUndefined();
    // The fallback lookup was attempted (and swallowed) after the update.
    expect(getServiceCallsAfterUpdate()).toBeGreaterThan(1);

    // No pin: readiness resolves from the live service as before.
    await sandbox.wait_ready(0.1, 0.02);
    expect(vi.mocked(api.getDeployment).mock.calls.map((call) => call[0])).toContain(OLD_DEPLOYMENT);
  });

  it('drops cached connection info so clients reconnect to the replacement', async () => {
    const { sandbox, api } = stubPolicyApi();
    vi.spyOn(api, 'getApp').mockResolvedValue({ domains: [{ name: 'old.example.org' }] } as never);

    const before = await sandbox.get_domain();
    expect(before).toContain('old.example.org');

    await sandbox.update_network_policy({ block_network: true });
    vi.mocked(api.getApp).mockResolvedValue({ domains: [{ name: 'new.example.org' }] } as never);

    await expect(sandbox.get_domain()).resolves.toContain('new.example.org');
  });

  it('wraps non-SDK failures as SandboxError, SDK errors pass through', async () => {
    const { sandbox, api } = stubPolicyApi({
      updateResponse: async () => {
        throw new TypeError('wire cut');
      },
    });

    const error = await sandbox.update_network_policy({ block_network: true }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxError);
    expect((error as Error).message).toContain('Failed to update network policy');

    vi.mocked(api.updateService).mockRejectedValue(new SandboxApiError(409, { message: 'conflict' }));
    const sdkError = await sandbox.update_network_policy({ block_network: true }).catch((error: unknown) => error);

    expect(sdkError).toBeInstanceOf(SandboxApiError);
  });

  it('get_from_id pins the resolved deployment for later readiness polls', async () => {
    stubControlPlane({
      service: {
        id: SERVICE_ID,
        app_id: APP_ID,
        name: 'sbx',
        status: 'HEALTHY',
        active_deployment_id: 'dep-a',
        latest_deployment_id: 'dep-b',
      } as koyeb.Service,
    });

    const sandbox = await Sandbox.get_from_id(SERVICE_ID, 'token');
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    // The service's live deployment changes after reconnection.
    vi.spyOn(api, 'getService').mockResolvedValue({
      active_deployment_id: 'dep-c',
      latest_deployment_id: 'dep-c',
    } as never);
    const polled: string[] = [];
    vi.spyOn(api, 'getDeployment').mockImplementation(async (id: string) => {
      polled.push(id);
      return { status: 'HEALTHY' } as never;
    });

    await sandbox.wait_ready(0.1, 0.02);

    expect(polled).toContain('dep-a');
    expect(polled).not.toContain('dep-c');
  });
});

describe('create() parity with the Python SDK', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not pre-flight against a hardcoded foreign app', async () => {
    const { calls } = stubControlPlane({});

    await Sandbox.create({ wait_ready: false, api_token: 'token' });

    const servicePosts = calls.filter((call) => call.url.endsWith('/v1/services') && call.method === 'POST');
    const firstCall = calls[0];

    // Exactly one service create (the real one), and the first API call is
    // the app creation — no dry-run against someone else's app id.
    expect(servicePosts).toHaveLength(1);
    expect(firstCall.url.endsWith('/v1/apps')).toBe(true);
  });

  it('reuses an existing app when app_id is given', async () => {
    const { calls } = stubControlPlane({});

    await Sandbox.create({ wait_ready: false, api_token: 'token', app_id: 'my-app' });

    expect(calls.some((call) => call.url.endsWith('/v1/apps') && call.method === 'POST')).toBe(false);
    const servicePost = calls.find((call) => call.url.endsWith('/v1/services') && call.method === 'POST');
    expect((servicePost!.body as { app_id: string }).app_id).toBe('my-app');
  });

  it('uses the provided sandbox_secret instead of generating one', async () => {
    const { calls } = stubControlPlane({});

    const sandbox = await Sandbox.create({ wait_ready: false, api_token: 'token', sandbox_secret: 'my-secret' });

    const servicePost = calls.find((call) => call.url.endsWith('/v1/services') && call.method === 'POST');
    const definition = (servicePost!.body as { definition: koyeb.DeploymentDefinition }).definition;
    expect(definition.env?.find(({ key }) => key === 'SANDBOX_SECRET')?.value).toBe('my-secret');
    expect((sandbox as unknown as { sandbox_secret: string }).sandbox_secret).toBe('my-secret');
  });

  it('honors a custom API host', async () => {
    const { calls } = stubControlPlane({});

    await Sandbox.create({ wait_ready: false, api_token: 'token', host: 'https://example.org' });

    expect(calls[0].url.startsWith('https://example.org/')).toBe(true);
  });
});

describe('list() parity with the Python SDK', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function stubServicesPage(count: number) {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : (input as string));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const services = Array.from({ length: Math.min(limit, Math.max(0, count - offset)) }, (_, i) => ({
        id: `svc-${offset + i}`,
        app_id: `app-${offset + i}`,
        name: `sbx-${offset + i}`,
      }));
      return jsonResponse({ services, count });
    });

    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('paginates sandbox-typed services 100 at a time', async () => {
    const fetch = stubServicesPage(150);

    const found = await Sandbox.list({ api_token: 'token' });

    expect(found).toHaveLength(150);
    expect(found[0].id).toBe('svc-0');
    expect(found[149].id).toBe('svc-149');
    expect(fetch).toHaveBeenCalledTimes(2);

    const first = new URL((fetch.mock.calls[0][0] as Request).url);
    expect(first.searchParams.get('types')).toBe('SANDBOX');
    expect(first.searchParams.get('limit')).toBe('100');
    expect(first.searchParams.get('offset')).toBe('0');
    const second = new URL((fetch.mock.calls[1][0] as Request).url);
    expect(second.searchParams.get('offset')).toBe('100');
  });

  it('passes app_id and name filters through', async () => {
    const fetch = stubServicesPage(1);

    await Sandbox.list({ app_id: 'app-9', name: 'sb', api_token: 'token' });

    const url = new URL((fetch.mock.calls[0][0] as Request).url);
    expect(url.searchParams.get('app_id')).toBe('app-9');
    expect(url.searchParams.get('name')).toBe('sb');
  });

  it('returns an empty list for an empty account', async () => {
    stubServicesPage(0);

    expect(await Sandbox.list({ api_token: 'token' })).toEqual([]);
  });

  it('returns lazy handles whose connected ops name the fix', async () => {
    stubServicesPage(1);

    const [handle] = await Sandbox.list({ api_token: 'token' });

    expect((handle as unknown as { sandbox_secret?: string }).sandbox_secret).toBeUndefined();
    expect(handle.id).toBe('svc-0');
    expect(handle.name).toBe('sbx-0');

    const error = await handle.exec('ls').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(NoSandboxSecretError);
    expect((error as Error).message).toContain('Sandbox.get_from_id');
  });

  it('requires an API token', async () => {
    vi.stubEnv('KOYEB_API_TOKEN', '');

    await expect(Sandbox.list()).rejects.toBeInstanceOf(MissingApiTokenError);
  });
});

describe('readiness parity', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('get_from_id prefers the active deployment', async () => {
    stubControlPlane({
      service: {
        id: SERVICE_ID,
        app_id: APP_ID,
        name: 'sbx',
        status: 'HEALTHY',
        active_deployment_id: 'dep-active',
        latest_deployment_id: 'dep-latest',
      } as koyeb.Service,
      deployment: { id: 'dep-active', definition: { env: [{ key: 'SANDBOX_SECRET', value: 'sec' }] } } as koyeb.Deployment,
    });

    await Sandbox.get_from_id(SERVICE_ID, 'token');

    const deploymentCall = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([request]) => request as Request)
      .find((request) => request.url.includes('/v1/deployments/'));
    expect(deploymentCall!.url).toContain('dep-active');
  });

  it('get_from_id names the real problem when the deployment has no SANDBOX_SECRET', async () => {
    stubControlPlane({
      deployment: {
        id: DEPLOYMENT_ID,
        status: 'HEALTHY',
        definition: { env: [] },
      } as koyeb.Deployment,
    });

    const error = await Sandbox.get_from_id(SERVICE_ID, 'token').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(NoSandboxSecretError);
    expect((error as Error).message).toBe(
      `Sandbox '${SERVICE_ID}' has no SANDBOX_SECRET in its deployment definition — it may not be a Koyeb sandbox service, so the executor connection cannot be established.`,
    );
  });

  it('get_from_id explains when the service has no deployment to inspect', async () => {
    stubControlPlane({
      service: { id: SERVICE_ID, app_id: APP_ID, name: 'sbx' } as koyeb.Service,
    });

    const error = await Sandbox.get_from_id(SERVICE_ID, 'token').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(NoSandboxSecretError);
    expect((error as Error).message).toContain('has no SANDBOX_SECRET');
  });

  it('bounds the executor health probe like Python', async () => {
    stubControlPlane({ health: () => new Response('OK', { status: 200 }) });

    const sandbox = new Sandbox(APP_ID, SERVICE_ID, 'sbx', 'sec', 'token');
    await sandbox.is_healthy();

    const healthCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).endsWith('/health'),
      );
    expect(healthCalls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails fast when the deployment reaches a terminal state, even when the executor answers', async () => {
    stubControlPlane({
      deployment: {
        id: DEPLOYMENT_ID,
        status: 'STOPPED',
        definition: { env: [{ key: 'SANDBOX_SECRET', value: 'secret' }] },
      } as koyeb.Deployment,
      health: () => new Response('OK', { status: 200 }),
    });

    const sandbox = new Sandbox(APP_ID, SERVICE_ID, 'sbx', 'sec', 'token');

    await expect(sandbox.wait_ready(1, 0.01)).rejects.toBeInstanceOf(SandboxDeploymentError);
  });

  it('a healthy deployment is ready even when the service status looks bad', async () => {
    stubControlPlane({
      service: {
        id: SERVICE_ID,
        app_id: APP_ID,
        name: 'sbx',
        status: 'UNHEALTHY',
        active_deployment_id: DEPLOYMENT_ID,
        latest_deployment_id: DEPLOYMENT_ID,
      } as koyeb.Service,
      health: () => new Response('OK', { status: 200 }),
    });

    const sandbox = new Sandbox(APP_ID, SERVICE_ID, 'sbx', 'sec', 'token');

    await expect(sandbox.wait_ready(1, 0.01)).resolves.toBe(true);
  });

  it('keeps polling through transient control-plane errors', async () => {
    let failures = 1;
    const { calls } = stubControlPlane({
      health: () => new Response('OK', { status: 200 }),
    });
    const rawFetch = vi.mocked(globalThis.fetch);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === `/v1/services/${SERVICE_ID}` && failures-- > 0) {
          return new Response('boom', { status: 500 });
        }
        return rawFetch(request, init);
      }),
    );

    const sandbox = new Sandbox(APP_ID, SERVICE_ID, 'sbx', 'sec', 'token');

    await expect(sandbox.wait_ready(2, 0.01)).resolves.toBe(true);
    expect(calls.some((call) => call.url.endsWith('/health'))).toBe(true);
  });

  function stubDeploymentApi(sandbox: Sandbox, deploymentStatus: () => koyeb.DeploymentStatus) {
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    const getService = vi.spyOn(api, 'getService').mockImplementation(async () => ({
      active_deployment_id: DEPLOYMENT_ID,
    }));
    const getDeployment = vi
      .spyOn(api, 'getDeployment')
      .mockImplementation(async () => ({ status: deploymentStatus() }));

    return { getService, getDeployment };
  }

  it('waits with the instance poll interval by default', async () => {
    const sandbox = new Sandbox(APP_ID, SERVICE_ID, 'sbx', 'sec', 'token', undefined, true, 0.02);
    const { getService, getDeployment } = stubDeploymentApi(sandbox, () => 'STARTING');

    await expect(sandbox.wait_ready(0.12)).resolves.toBe(false);

    // 0.02s polls fit ~6 deployment checks in the budget; the 0.5s default manages 2.
    expect(getDeployment.mock.calls.length).toBeGreaterThan(4);
    // The deployment id resolves once and is cached, like Python's _resolve_deployment_id.
    expect(getService.mock.calls.length).toBe(1);
  });

  it('latches deployment health, then polls only the executor, like Python', async () => {
    const sandbox = new Sandbox(APP_ID, SERVICE_ID, 'sbx', 'sec', 'token', undefined, true, 0.02);
    let polls = 0;
    const { getDeployment } = stubDeploymentApi(sandbox, () => (++polls < 3 ? 'STARTING' : 'HEALTHY'));
    vi.spyOn(sandbox, 'get_conn_info').mockResolvedValue({
      public_url: 'https://sbx.example.org',
      secret: 'sec',
    } as never);
    const health = vi.fn(async () => new Response('no', { status: 503 }));
    vi.stubGlobal('fetch', health);

    await expect(sandbox.wait_ready(0.3, 0.02)).resolves.toBe(false);

    // The deployment is polled only until first healthy; the executor polls on.
    expect(getDeployment.mock.calls.length).toBe(3);
    expect(health.mock.calls.length).toBeGreaterThan(4);
  });

  it('create() deletes the app when the deployment reaches a terminal state', async () => {
    const { calls } = stubControlPlane({
      deployment: {
        id: DEPLOYMENT_ID,
        status: 'STOPPED',
        definition: { env: [{ key: 'SANDBOX_SECRET', value: 'secret' }] },
      } as koyeb.Deployment,
      health: () => new Response('OK', { status: 200 }),
    });

    const error = await Sandbox.create({
      wait_ready: true,
      timeout: 1,
      poll_interval: 0.01,
      api_token: 'token',
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxDeploymentError);
    expect((error as Error).message).toContain('The sandbox was deleted.');
    expect(calls.some((call) => call.url.includes(`/v1/apps/${APP_ID}`) && call.method === 'DELETE')).toBe(true);
  });

  it('create() in a caller app cleans up only the sandbox service', async () => {
    const { calls } = stubControlPlane({
      deployment: {
        id: DEPLOYMENT_ID,
        status: 'STOPPED',
        definition: { env: [{ key: 'SANDBOX_SECRET', value: 'secret' }] },
      } as koyeb.Deployment,
    });

    await expect(
      Sandbox.create({
        wait_ready: true,
        timeout: 1,
        poll_interval: 0.01,
        api_token: 'token',
        app_id: 'my-app',
      }),
    ).rejects.toBeInstanceOf(SandboxDeploymentError);

    expect(calls.some((call) => call.url.includes(`/v1/services/${SERVICE_ID}`) && call.method === 'DELETE')).toBe(
      true,
    );
    expect(calls.some((call) => call.url.includes(`/v1/apps/`) && call.method === 'DELETE')).toBe(false);
  });

  it('create() appends the deletion note to wait errors by default', async () => {
    const { calls } = stubControlPlane({
      service: {
        id: SERVICE_ID,
        app_id: APP_ID,
        name: 'sbx',
        status: 'DELETED',
        active_deployment_id: DEPLOYMENT_ID,
      } as koyeb.Service,
      deployment: {
        id: DEPLOYMENT_ID,
        status: 'STOPPED',
        definition: { env: [{ key: 'SANDBOX_SECRET', value: 'secret' }] },
      } as koyeb.Deployment,
    });

    const error = await Sandbox.create({
      wait_ready: true,
      timeout: 1,
      poll_interval: 0.01,
      api_token: 'token',
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxDeploymentError);
    expect((error as Error).message).toContain('The sandbox was deleted.');
    expect(calls.some((call) => call.url.includes(`/v1/apps/${APP_ID}`) && call.method === 'DELETE')).toBe(true);
  });

  it('cleanup_on_failure=false keeps a failed sandbox and its original error', async () => {
    const { calls } = stubControlPlane({
      service: {
        id: SERVICE_ID,
        app_id: APP_ID,
        name: 'sbx',
        status: 'DELETED',
        active_deployment_id: DEPLOYMENT_ID,
      } as koyeb.Service,
      deployment: {
        id: DEPLOYMENT_ID,
        status: 'STOPPED',
        definition: { env: [{ key: 'SANDBOX_SECRET', value: 'secret' }] },
      } as koyeb.Deployment,
    });

    const error = await Sandbox.create({
      wait_ready: true,
      timeout: 1,
      poll_interval: 0.01,
      api_token: 'token',
      cleanup_on_failure: false,
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxDeploymentError);
    expect((error as Error).message).not.toContain('The sandbox was deleted.');
    expect(calls.some((call) => call.url.includes(`/v1/apps/${APP_ID}`) && call.method === 'DELETE')).toBe(false);
  });

  it('createService failure deletes the created app without masking the error', async () => {
    const { calls } = stubControlPlane({
      serviceCreate: () => jsonResponse({}, 500),
    });
    // The cleanup delete fails too: the original create error must survive it.
    const rawFetch = vi.mocked(globalThis.fetch);
    let cleanupAttempted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === `/v1/apps/${APP_ID}` && request.method === 'DELETE') {
          cleanupAttempted = true;
          return jsonResponse({ message: 'app locked' }, 409);
        }
        return rawFetch(request, init);
      }),
    );

    const error = await Sandbox.create({ wait_ready: false, api_token: 'token' }).catch((error: unknown) => error);

    expect((error as Error).message).not.toContain('app locked');
    expect((error as Error).message).toContain('Koyeb API request failed: 500');
    expect(cleanupAttempted).toBe(true);
  });

  it('createService failure in a caller app touches no app', async () => {
    const { calls } = stubControlPlane({
      serviceCreate: () => jsonResponse({}, 500),
    });

    await Sandbox.create({ wait_ready: false, api_token: 'token', app_id: 'my-app' }).catch(() => undefined);

    expect(calls.some((call) => call.url.includes(`/v1/apps`) && call.method === 'DELETE')).toBe(false);
  });

  it('a failed cleanup says the sandbox may still exist, like Python', async () => {
    const { calls } = stubControlPlane({
      deployment: {
        id: DEPLOYMENT_ID,
        status: 'STOPPED',
        definition: { env: [{ key: 'SANDBOX_SECRET', value: 'secret' }] },
      } as koyeb.Deployment,
    });
    // The readiness failure triggers cleanup, but the app delete fails.
    const rawFetch = vi.mocked(globalThis.fetch);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === `/v1/apps/${APP_ID}` && request.method === 'DELETE') {
          return new Response('boom', { status: 500 });
        }
        return rawFetch(request, init);
      }),
    );

    const error = await Sandbox.create({
      wait_ready: true,
      timeout: 1,
      poll_interval: 0.01,
      api_token: 'token',
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxDeploymentError);
    expect((error as Error).message).toContain('The sandbox could not be deleted and may still exist.');
    expect(calls.some((call) => call.url.endsWith('/health'))).toBe(false);
  });

  it('a cleaned-up timeout names the opt-out, a kept one keeps the standard hint', async () => {
    const cleaned = stubControlPlane({ health: () => new Response('nope', { status: 503 }) });
    const cleanedError = await Sandbox.create({
      wait_ready: true,
      timeout: 0.05,
      api_token: 'token',
    }).catch((error: unknown) => error);

    expect(cleanedError).toBeInstanceOf(SandboxTimeoutError);
    expect((cleanedError as Error).message).toContain(
      'and was deleted. Create with cleanup_on_failure=False to keep a timed-out sandbox for inspection.',
    );
    expect(
      cleaned.calls.some((call) => call.url.includes(`/v1/apps/${APP_ID}`) && call.method === 'DELETE'),
    ).toBe(true);

    const kept = stubControlPlane({ health: () => new Response('nope', { status: 503 }) });
    const keptError = await Sandbox.create({
      wait_ready: true,
      timeout: 0.05,
      api_token: 'token',
      cleanup_on_failure: false,
    }).catch((error: unknown) => error);

    expect(keptError).toBeInstanceOf(SandboxTimeoutError);
    expect((keptError as Error).message).toContain('may not be ready yet');
    expect((keptError as Error).message).not.toContain('was deleted');
    expect(kept.calls.some((call) => call.url.includes(`/v1/apps/${APP_ID}`) && call.method === 'DELETE')).toBe(
      false,
    );
  });

  it('create() honors poll_interval for the readiness wait', async () => {
    let unhealthy = true;
    stubControlPlane({
      health: () => {
        if (unhealthy) {
          unhealthy = false;
          return new Response('nope', { status: 503 });
        }
        return new Response('OK', { status: 200 });
      },
    });

    const started = Date.now();
    await Sandbox.create({ wait_ready: true, timeout: 30, poll_interval: 0.05, api_token: 'token' });
    const elapsed = Date.now() - started;

    // With the 2s default interval this would take >= 2s; with 50ms it lands
    // well under a second.
    expect(elapsed).toBeLessThan(1_000);
  });
});
