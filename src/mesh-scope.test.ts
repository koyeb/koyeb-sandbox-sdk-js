import { afterEach, describe, expect, it, vi } from 'vitest';

import { KoyebApi } from './api.js';
import { buildNetworkPolicy, keepMesh } from './cidr.js';
import { buildDefinition } from './definition.js';
import { Sandbox } from './sandbox.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildNetworkPolicy mesh_scope', () => {
  it('sends no mesh by default', () => {
    expect(buildNetworkPolicy(false, undefined, undefined)).toBeUndefined();
  });

  it('sends the scope', () => {
    expect(buildNetworkPolicy(false, undefined, 'MESH_SCOPE_APP')).toEqual({ mesh: { scope: 'MESH_SCOPE_APP' } });
  });

  it('treats UNSPECIFIED as the default', () => {
    expect(buildNetworkPolicy(false, undefined, 'MESH_SCOPE_UNSPECIFIED')).toBeUndefined();
  });

  it('combines with an egress policy', () => {
    expect(buildNetworkPolicy(false, ['10.0.0.1'], 'MESH_SCOPE_WORKSPACE')).toEqual({
      egress: { mode: 'EGRESS_POLICY_MODE_DENY_ALL', allow_list: [{ cidr: '10.0.0.1/32' }] },
      mesh: { scope: 'MESH_SCOPE_WORKSPACE' },
    });
  });

  it('rejects CUSTOM, which needs a mesh name', () => {
    expect(() => buildNetworkPolicy(false, undefined, 'MESH_SCOPE_CUSTOM')).toThrow(/needs a mesh name/);
  });

  it('rejects an unknown scope', () => {
    expect(() => buildNetworkPolicy(false, undefined, 'MESH_SCOPE_GALAXY')).toThrow(/Invalid mesh_scope/);
  });
});

describe('keepMesh', () => {
  it('carries the current mesh into a new policy', () => {
    const policy = { egress: { mode: 'EGRESS_POLICY_MODE_DENY_ALL' as const } };
    expect(keepMesh(policy, { mesh: { scope: 'MESH_SCOPE_APP' } })).toEqual({
      ...policy,
      mesh: { scope: 'MESH_SCOPE_APP' },
    });
  });

  it('leaves the policy as is when there is no current mesh', () => {
    const policy = { egress: { mode: 'EGRESS_POLICY_MODE_DEFAULT' as const } };
    expect(keepMesh(policy, undefined)).toBe(policy);
    expect(keepMesh(policy, { egress: { mode: 'EGRESS_POLICY_MODE_DENY_ALL' } })).toBe(policy);
  });
});

describe('buildDefinition mesh_scope', () => {
  const base = { name: 'sb', image: 'koyeb/sandbox', instance_type: 'micro' };

  it('turns the mesh on with a scope', () => {
    const { definition } = buildDefinition({ ...base, mesh_scope: 'MESH_SCOPE_APP' });
    expect(definition.mesh).toBe('DEPLOYMENT_MESH_ENABLED');
    expect(definition.network_policy).toEqual({ mesh: { scope: 'MESH_SCOPE_APP' } });
  });

  it('keeps mesh AUTO and sends no network policy without a scope', () => {
    const { definition } = buildDefinition(base);
    expect(definition.mesh).toBe('DEPLOYMENT_MESH_AUTO');
    expect(definition.network_policy).toBeUndefined();
  });

  it('keeps an explicit enable_mesh: true', () => {
    const { definition } = buildDefinition({ ...base, enable_mesh: true, mesh_scope: 'MESH_SCOPE_ORGANIZATION' });
    expect(definition.mesh).toBe('DEPLOYMENT_MESH_ENABLED');
  });

  it('rejects a scope with enable_mesh: false', () => {
    expect(() => buildDefinition({ ...base, enable_mesh: false, mesh_scope: 'MESH_SCOPE_APP' })).toThrow(
      /enable_mesh is false/,
    );
  });

  it('rejects a scope on a free instance', () => {
    expect(() => buildDefinition({ ...base, instance_type: 'free', mesh_scope: 'MESH_SCOPE_APP' })).toThrow(
      /free instances/,
    );
  });

  it('ignores the scope in pool mode', () => {
    const { definition } = buildDefinition({ ...base, mesh_scope: 'MESH_SCOPE_APP' }, { pool: true });
    expect(definition.mesh).toBe('DEPLOYMENT_MESH_AUTO');
    expect(definition.network_policy).toBeUndefined();
  });
});

describe('Sandbox.create mesh_scope', () => {
  function stubCreate() {
    vi.spyOn(KoyebApi.prototype, 'createApp').mockResolvedValue({ id: 'app-1' } as never);
    const createService = vi
      .spyOn(KoyebApi.prototype, 'createService')
      .mockResolvedValue({ id: 'svc-1', app_id: 'app-1', name: 'sb' } as never);
    return createService;
  }

  it('sends the scope and turns the mesh on', async () => {
    const createService = stubCreate();

    await Sandbox.create({ api_token: 'token', name: 'sb', wait_ready: false, mesh_scope: 'MESH_SCOPE_APP' });

    const body = createService.mock.calls[0][0];
    expect(body.definition?.mesh).toBe('DEPLOYMENT_MESH_ENABLED');
    expect(body.definition?.network_policy).toEqual({ mesh: { scope: 'MESH_SCOPE_APP' } });
  });

  it('sends the same definition as before without a scope', async () => {
    const createService = stubCreate();

    await Sandbox.create({ api_token: 'token', name: 'sb', wait_ready: false });

    const body = createService.mock.calls[0][0];
    expect(body.definition?.mesh).toBe('DEPLOYMENT_MESH_AUTO');
    expect(body.definition?.network_policy).toBeUndefined();
  });

  it('rejects a full snapshot before creating anything', async () => {
    const createApp = vi.spyOn(KoyebApi.prototype, 'createApp');
    const snapshot = { id: 'snap-1', snapshot_type: 'FULL' } as never;

    await expect(
      Sandbox.create({ api_token: 'token', name: 'sb', snapshot, mesh_scope: 'MESH_SCOPE_APP' }),
    ).rejects.toThrow(/full snapshot/);
    expect(createApp).not.toHaveBeenCalled();
  });

  it('keeps the scope with a filesystem snapshot', async () => {
    const createService = stubCreate();
    const snapshot = { id: 'snap-1', snapshot_type: 'FILESYSTEM' } as never;

    await Sandbox.create({ api_token: 'token', name: 'sb', wait_ready: false, snapshot, mesh_scope: 'MESH_SCOPE_APP' });

    expect(createService.mock.calls[0][0].definition?.network_policy).toEqual({ mesh: { scope: 'MESH_SCOPE_APP' } });
  });
});

describe('update_network_policy keeps the mesh scope', () => {
  function stub(network_policy?: unknown) {
    const sandbox = new Sandbox('app-1', 'svc-1', 'sb', 'secret', 'token');
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    vi.spyOn(api, 'getService').mockResolvedValue({ latest_deployment_id: 'dep-1' } as never);
    vi.spyOn(api, 'getDeployment').mockResolvedValue({ definition: { name: 'sb', network_policy } } as never);
    const update = vi.spyOn(api, 'updateService').mockResolvedValue({ latest_deployment_id: 'dep-2' } as never);
    return { sandbox, update };
  }

  it('changes egress and keeps the current scope', async () => {
    const { sandbox, update } = stub({ mesh: { scope: 'MESH_SCOPE_APP' } });

    await sandbox.update_network_policy({ block_network: true });

    expect(update.mock.calls[0][1].definition?.network_policy).toEqual({
      egress: { mode: 'EGRESS_POLICY_MODE_DENY_ALL' },
      mesh: { scope: 'MESH_SCOPE_APP' },
    });
  });

  it('keeps the scope on reset to the default', async () => {
    const { sandbox, update } = stub({
      egress: { mode: 'EGRESS_POLICY_MODE_DENY_ALL' },
      mesh: { scope: 'MESH_SCOPE_WORKSPACE' },
    });

    await sandbox.update_network_policy();

    expect(update.mock.calls[0][1].definition?.network_policy).toEqual({
      egress: { mode: 'EGRESS_POLICY_MODE_DEFAULT' },
      mesh: { scope: 'MESH_SCOPE_WORKSPACE' },
    });
  });

  it('sends no mesh when the sandbox had none', async () => {
    const { sandbox, update } = stub(undefined);

    await sandbox.update_network_policy({ block_network: true });

    expect(update.mock.calls[0][1].definition?.network_policy).toEqual({
      egress: { mode: 'EGRESS_POLICY_MODE_DENY_ALL' },
    });
  });
});
