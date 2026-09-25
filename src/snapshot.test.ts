import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KoyebApi } from './api.js';
import { Sandbox } from './sandbox.js';
import { DeclarativeSnapshot } from './declarative-snapshot.js';
import { Snapshot } from './snapshot.js';
import { MissingApiTokenError, SandboxError, SandboxTimeoutError } from './errors.js';

const MODEL = {
  id: 'snap-1',
  name: 'snap',
  service_id: 'svc-1',
  created_at: '2026-09-24T00:00:00Z',
  available_at: '2026-09-24T00:01:00Z',
  status: 'INSTANCE_SNAPSHOT_STATUS_AVAILABLE',
  type: 'INSTANCE_SNAPSHOT_TYPE_FILESYSTEM',
  messages: [],
  deployment_id: 'dep-1',
  organization_id: 'org-1',
  instance_id: 'inst-9',
};

function makeSandbox() {
  return new Sandbox('app-1', 'svc-1', 'sbx', 'secret', 'token');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Snapshot', () => {
  it('get maps API fields onto the SDK type', async () => {
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockResolvedValue(MODEL as never);

    const snapshot = await Snapshot.get('snap-1', { api_token: 't' });

    expect(snapshot.id).toBe('snap-1');
    expect(snapshot.snapshot_type).toBe('FILESYSTEM');
    expect(snapshot.status).toBe('AVAILABLE');
    expect(snapshot.service_id).toBe('svc-1');
  });

  it('get rejects with SandboxError when the API returns nothing', async () => {
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockResolvedValue(undefined as never);

    await expect(Snapshot.get('snap-1', { api_token: 't' })).rejects.toBeInstanceOf(SandboxError);
  });

  it('list maps filters to the API query', async () => {
    const listSpy = vi
      .spyOn(KoyebApi.prototype, 'listInstanceSnapshots')
      .mockResolvedValue([MODEL] as never);

    const snapshots = await Snapshot.list({ type: 'FULL', status: 'ERROR', limit: '10', api_token: 't' });

    expect(listSpy.mock.calls[0][0]).toEqual({
      type: 'INSTANCE_SNAPSHOT_TYPE_FULL',
      statuses: ['INSTANCE_SNAPSHOT_STATUS_ERROR'],
      limit: '10',
    });
    expect(snapshots[0].snapshot_type).toBe('FILESYSTEM');
  });

  it('refresh updates state from the API but keeps operations', async () => {
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockResolvedValue({ ...MODEL, status: 'INSTANCE_SNAPSHOT_STATUS_CREATING' } as never);
    const snapshot = await Snapshot.get('snap-1', { api_token: 't' });
    snapshot.operations.push('create_file: /a');

    await snapshot.refresh();

    expect(snapshot.status).toBe('CREATING');
    expect(snapshot.operations).toEqual(['create_file: /a']);
  });

  it('wait_available resolves true once AVAILABLE', async () => {
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockResolvedValue(MODEL as never);
    const snapshot = await Snapshot.get('snap-1', { api_token: 't' });

    await expect(snapshot.wait_available(1, 0.01)).resolves.toBe(true);
  });

  it('wait_available resolves false when the snapshot errors', async () => {
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockResolvedValue({ ...MODEL, status: 'INSTANCE_SNAPSHOT_STATUS_ERROR' } as never);
    const snapshot = await Snapshot.get('snap-1', { api_token: 't' });

    await expect(snapshot.wait_available(1, 0.01)).resolves.toBe(false);
  });

  it('delete calls the API with the snapshot id', async () => {
    const deleteSpy = vi.spyOn(KoyebApi.prototype, 'deleteInstanceSnapshot').mockResolvedValue(MODEL as never);
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockResolvedValue(MODEL as never);
    const snapshot = await Snapshot.get('snap-1', { api_token: 't' });

    await snapshot.delete();

    expect(deleteSpy).toHaveBeenCalledWith('snap-1');
  });

  it('spawn creates a sandbox carrying this snapshot and its secret', async () => {
    const createSpy = vi.spyOn(Sandbox, 'create').mockResolvedValue(makeSandbox());
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockResolvedValue(MODEL as never);
    const snapshot = await Snapshot.get('snap-1', { api_token: 't' });
    snapshot.sandbox_secret = 'sec';

    await snapshot.spawn('runner');

    expect(createSpy.mock.calls[0][0]).toMatchObject({
      snapshot,
      name: 'runner',
      api_token: 't',
      sandbox_secret: 'sec',
    });
  });
});

describe('Sandbox.snapshot', () => {
  it('snapshots the first running instance', async () => {
    const sandbox = makeSandbox();
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    const listInstances = vi.spyOn(api, 'listInstances').mockResolvedValue([{ id: 'inst-1' }] as never);
    const createSnapshot = vi
      .spyOn(api, 'createInstanceSnapshot')
      .mockResolvedValue({ ...MODEL, status: 'INSTANCE_SNAPSHOT_STATUS_CREATING' } as never);
    vi.spyOn(Snapshot.prototype, 'refresh').mockImplementation(async function (this: Snapshot) {
      this.status = 'AVAILABLE';
    });

    const snapshot = await sandbox.snapshot('snap', { timeout: 1 });

    expect(listInstances.mock.calls[0][0]).toMatchObject({
      service_id: 'svc-1',
      statuses: ['HEALTHY', 'STARTING', 'ALLOCATING'],
      limit: '1',
    });
    expect(createSnapshot.mock.calls[0][0]).toEqual({
      instance_id: 'inst-1',
      name: 'snap',
      type: 'INSTANCE_SNAPSHOT_TYPE_FILESYSTEM',
    });
    expect(snapshot.status).toBe('AVAILABLE');
  });

  it('rejects when the service has no running instances', async () => {
    const sandbox = makeSandbox();
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    vi.spyOn(api, 'listInstances').mockResolvedValue([] as never);

    await expect(sandbox.snapshot('snap')).rejects.toBeInstanceOf(SandboxError);
  });

  it('rejects with SandboxError when the snapshot errors while waiting', async () => {
    const sandbox = makeSandbox();
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    vi.spyOn(api, 'listInstances').mockResolvedValue([{ id: 'inst-1' }] as never);
    vi.spyOn(api, 'createInstanceSnapshot').mockResolvedValue(MODEL as never);
    vi.spyOn(Snapshot.prototype, 'refresh').mockImplementation(async function (this: Snapshot) {
      this.status = 'ERROR';
    });

    await expect(sandbox.snapshot('snap', { timeout: 1 })).rejects.toBeInstanceOf(SandboxError);
  });

  it('wraps the availability timeout like Python: SandboxError, no snapshot name', async () => {
    const sandbox = makeSandbox();
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    vi.spyOn(api, 'listInstances').mockResolvedValue([{ id: 'inst-1' }] as never);
    vi.spyOn(api, 'createInstanceSnapshot').mockResolvedValue(MODEL as never);
    vi.spyOn(Snapshot.prototype, 'refresh').mockImplementation(async function (this: Snapshot) {
      this.status = 'CREATING';
    });

    const error = await sandbox.snapshot('snap', { timeout: 0.05, poll_interval: 0.01 }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxError);
    expect((error as Error).message).toBe(
      'Failed to create snapshot: Snapshot did not become available within 0.05 seconds',
    );
  });

  it('polls availability with the sandbox poll interval, defaulting to 0.5s', async () => {
    const sandbox = new Sandbox('app-1', 'svc-1', 'sbx', 'secret', 'token', undefined, true, 0.01);
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    vi.spyOn(api, 'listInstances').mockResolvedValue([{ id: 'inst-1' }] as never);
    vi.spyOn(api, 'createInstanceSnapshot').mockResolvedValue(MODEL as never);
    const refresh = vi
      .spyOn(Snapshot.prototype, 'refresh')
      .mockImplementation(async function (this: Snapshot) {
        this.status = 'CREATING';
      });

    await sandbox.snapshot('snap', { timeout: 0.1 }).catch(() => undefined);

    // At 0.01s intervals ~10 polls fit in the 0.1s budget; the 5s snapshot
    // default or an unthreaded interval would manage only one.
    expect(refresh.mock.calls.length).toBeGreaterThan(3);
  });

  it('wraps missing instances like Python', async () => {
    const sandbox = makeSandbox();
    const api = (sandbox as unknown as { api: KoyebApi }).api;
    vi.spyOn(api, 'listInstances').mockResolvedValue([] as never);

    const error = await sandbox.snapshot('snap').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxError);
    expect((error as Error).message).toBe(
      `Failed to create snapshot: No running instances found for service svc-1`,
    );
  });
});

describe('create from snapshot', () => {
  function stubCreateService() {
    const body = vi.fn();
    vi.spyOn(KoyebApi.prototype, 'createApp').mockResolvedValue({ id: 'app-1' } as never);
    vi.spyOn(KoyebApi.prototype, 'createService').mockImplementation(async (arg: unknown) => {
      body(arg);
      return { app_id: 'app-1', id: 'svc-2', name: 'sbx' } as never;
    });
    return body;
  }

  it('boots a FILESYSTEM snapshot with a definition', async () => {
    const body = stubCreateService();
    const snapshot = await Promise.resolve({ id: 'snap-1', snapshot_type: 'FILESYSTEM' } as Snapshot);

    await Sandbox.create({ snapshot, name: 'sbx', api_token: 't', wait_ready: false });

    expect(body.mock.calls[0][0]).toMatchObject({ instance_snapshot_id: 'snap-1' });
    expect((body.mock.calls[0][0] as { definition?: unknown }).definition).toBeDefined();
  });

  it('boots a FULL snapshot without a definition (the API infers it)', async () => {
    const body = stubCreateService();
    const snapshot = { id: 'snap-2', snapshot_type: 'FULL' } as Snapshot;

    await Sandbox.create({ snapshot, name: 'sbx', api_token: 't', wait_ready: false });

    expect(body.mock.calls[0][0]).toMatchObject({ instance_snapshot_id: 'snap-2' });
    expect((body.mock.calls[0][0] as { definition?: unknown }).definition).toBeUndefined();
  });

  it('resolves a snapshot name via get', async () => {
    const body = stubCreateService();
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockResolvedValue(MODEL as never);

    await Sandbox.create({ snapshot: 'snap', name: 'sbx', api_token: 't', wait_ready: false });

    expect(body.mock.calls[0][0]).toMatchObject({ instance_snapshot_id: 'snap-1' });
  });

  it('resolves a snapshot name via the list fallback', async () => {
    const body = stubCreateService();
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockRejectedValue(new SandboxError('not found'));
    vi.spyOn(KoyebApi.prototype, 'listInstanceSnapshots').mockResolvedValue([
      { ...MODEL, id: 'snap-named', name: 'named-snap' },
    ] as never);

    await Sandbox.create({ snapshot: 'named-snap', name: 'sbx', api_token: 't', wait_ready: false });

    expect(body.mock.calls[0][0]).toMatchObject({ instance_snapshot_id: 'snap-named' });
  });

  it('falls back to treating an unresolvable string as a snapshot ID, like Python', async () => {
    const body = stubCreateService();
    vi.spyOn(KoyebApi.prototype, 'getInstanceSnapshot').mockRejectedValue(new SandboxError('not found'));
    vi.spyOn(KoyebApi.prototype, 'listInstanceSnapshots').mockRejectedValue(new SandboxError('list failed'));

    await Sandbox.create({ snapshot: 'unresolvable-id', name: 'sbx', api_token: 't', wait_ready: false });

    expect(body.mock.calls[0][0]).toMatchObject({ instance_snapshot_id: 'unresolvable-id' });
  });

  it('create_from_snapshot delegates to create', async () => {
    const createSpy = vi.spyOn(Sandbox, 'create').mockResolvedValue(makeSandbox());
    const snapshot = { id: 'snap-1', snapshot_type: 'FILESYSTEM' } as Snapshot;

    await Sandbox.create_from_snapshot(snapshot, 'runner', { api_token: 't' });

    expect(createSpy.mock.calls[0][0]).toMatchObject({ snapshot, name: 'runner', api_token: 't' });
  });
});

describe('DeclarativeSnapshot', () => {
  it('template() returns a fluent builder', () => {
    const builder = Sandbox.template('python-ci', 'python:3.12', { api_token: 't' });

    expect(builder.file('requirements.txt', 'pytest')).toBe(builder);
    expect(builder.run('pip install -r requirements.txt')).toBe(builder);
    expect(builder.copy('/tmp/x', '/remote/x')).toBe(builder);
  });

  it('requires an API token', () => {
    vi.stubEnv('KOYEB_API_TOKEN', '');

    expect(() => Sandbox.template('tpl', 'python:3.12')).toThrow(MissingApiTokenError);
  });

  function builderMock() {
    return {
      filesystem: {
        mkdir: vi.fn(),
        write_file: vi.fn(),
      },
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      snapshot: vi.fn(async () => ({ id: 'snap-9', operations: [] })),
      delete: vi.fn(async () => {}),
    };
  }

  it('build() runs the recipe on a builder sandbox and snapshots it', async () => {
    const builder = builderMock();
    vi.spyOn(Sandbox, 'create').mockResolvedValue(builder as never);

    const snapshot = await Sandbox.template('python-ci', 'python:3.12', { api_token: 't', workdir: '/workspace' })
      .file('requirements.txt', 'pytest')
      .run('pip install -r requirements.txt')
      .build();

    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'python:3.12', name: 'builder-python-ci', api_token: 't' }),
    );
    expect(builder.filesystem.mkdir).toHaveBeenCalledWith('/workspace');
    expect(builder.filesystem.write_file).toHaveBeenCalledWith('requirements.txt', 'pytest');
    // Python's builder runs recipe commands with a 300s timeout.
    expect(builder.exec).toHaveBeenCalledWith('pip install -r requirements.txt', { timeout: 300 });
    expect(builder.snapshot).toHaveBeenCalledWith('python-ci', expect.anything());
    expect(snapshot.operations).toEqual(
      expect.arrayContaining([expect.stringContaining('create_file: requirements.txt'), expect.stringContaining('run: pip install')]),
    );
    expect(builder.delete).toHaveBeenCalled();
  });

  it('build() fails on a failing command but still deletes the builder', async () => {
    const builder = builderMock();
    builder.exec.mockResolvedValue({ stdout: '', stderr: 'boom', code: 1 });
    vi.spyOn(Sandbox, 'create').mockResolvedValue(builder as never);

    await expect(
      Sandbox.template('tpl', 'python:3.12', { api_token: 't' }).run('false').build(),
    ).rejects.toBeInstanceOf(SandboxError);
    expect(builder.delete).toHaveBeenCalled();
  });

  it('build() keeps the builder when delete_builder is false', async () => {
    const builder = builderMock();
    vi.spyOn(Sandbox, 'create').mockResolvedValue(builder as never);

    await Sandbox.template('tpl', 'python:3.12', { api_token: 't', delete_builder: false }).build();

    expect(builder.delete).not.toHaveBeenCalled();
  });

  it('copy() walks local directories, creating them like Python', async () => {
    const builder = builderMock();
    vi.spyOn(Sandbox, 'create').mockResolvedValue(builder as never);
    const dir = await mkdtemp(join(tmpdir(), 'koyeb-copy-'));
    await writeFile(join(dir, 'a.txt'), 'hello');
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', 'b.txt'), 'deep');

    try {
      await Sandbox.template('tpl', 'python:3.12', { api_token: 't' }).copy(dir, '/remote').build();

      // Python mkdirs each subdirectory, but relies on parent auto-creation
      // for the top-level destination.
      expect(builder.filesystem.mkdir).toHaveBeenCalledWith('/remote/nested');
      expect(builder.filesystem.mkdir).not.toHaveBeenCalledWith('/remote');
      expect(builder.filesystem.write_file).toHaveBeenCalledWith('/remote/a.txt', 'hello');
      expect(builder.filesystem.write_file).toHaveBeenCalledWith('/remote/nested/b.txt', 'deep');
      expect(builder.delete).toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
