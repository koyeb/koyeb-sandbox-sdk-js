import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KoyebApi,
  Sandbox,
  SandboxDeploymentError,
  SandboxServiceError,
  SandboxTimeoutError,
  Snapshot,
  SnapshotStatus,
  SnapshotType,
} from '../lib/index.js';

function createSandbox() {
  const sandbox = new Sandbox('app-id', 'service-id', 'sandbox', 'secret', 'token');
  sandbox._conn_info = {
    public_url: 'https://sandbox.example.test/koyeb-sandbox',
    secret: 'secret',
  };
  return sandbox;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('retries 503 executor responses three times', async (t) => {
  const sandbox = createSandbox();
  let calls = 0;

  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls < 4 ? jsonResponse({ error: 'unavailable' }, 503) : jsonResponse({ ok: true });
  });

  const result = await sandbox.request('/test', { method: 'GET' }, undefined, { initialBackoff: 0 });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 4);
});

test('maps executor timeouts and server errors', async (t) => {
  const sandbox = createSandbox();

  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });

  await assert.rejects(
    sandbox.request('/test', { method: 'GET' }, undefined, { timeout: 0.001, maxRetries: 0 }),
    SandboxTimeoutError,
  );

  globalThis.fetch.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'broken' }, 500));

  await assert.rejects(sandbox.request('/test', { method: 'GET' }, undefined, { maxRetries: 0 }), SandboxServiceError);
});

test('wait_ready checks deployment state before executor health', async (t) => {
  const sandbox = createSandbox();
  sandbox._conn_info = undefined;
  let deploymentCalls = 0;
  let healthCalls = 0;

  sandbox.api = {
    getService: async () => ({ active_deployment_id: 'deployment-id' }),
    getDeployment: async () => {
      deploymentCalls++;
      if (deploymentCalls === 1) {
        return { status: 'STARTING' };
      }
      return {
        status: 'HEALTHY',
        metadata: { sandbox: { public_url: 'https://sandbox.example.test', routing_key: 'route' } },
      };
    },
  };

  t.mock.method(globalThis, 'fetch', async () => {
    healthCalls++;
    return jsonResponse({ status: 'ready' });
  });

  assert.equal(await sandbox.wait_ready(1, 0), true);
  assert.equal(deploymentCalls, 2);
  assert.equal(healthCalls, 1);
});

test('wait_ready tolerates a temporary executor connection failure', async (t) => {
  const sandbox = createSandbox();
  sandbox._deployment_id = 'deployment-id';
  sandbox.api = {
    getDeployment: async () => ({ status: 'HEALTHY' }),
  };
  let healthCalls = 0;

  t.mock.method(globalThis, 'fetch', async () => {
    healthCalls++;
    if (healthCalls === 1) {
      throw new TypeError('connection reset');
    }
    return jsonResponse({ status: 'healthy' });
  });

  assert.equal(await sandbox.wait_ready(1, 0), true);
  assert.equal(healthCalls, 2);
});

test('wait_ready stops on a terminal deployment state', async () => {
  const sandbox = createSandbox();
  sandbox.api = {
    getService: async () => ({ active_deployment_id: 'deployment-id' }),
    getDeployment: async () => ({ status: 'ERROR' }),
  };

  await assert.rejects(sandbox.wait_ready(1, 0), SandboxDeploymentError);
});

test('update_lifecycle preserves values which are not supplied', async () => {
  const sandbox = createSandbox();
  let updateBody;

  sandbox.api = {
    getService: async () => ({
      latest_deployment_id: 'deployment-id',
      life_cycle: { delete_after_create: 10, delete_after_sleep: 20 },
    }),
    getDeployment: async () => ({ definition: { name: 'sandbox' } }),
    updateService: async (_id, body) => {
      updateBody = body;
      return {};
    },
  };

  await sandbox.update_lifecycle({ delete_after_delay: 30 });

  assert.deepEqual(updateBody.life_cycle, { delete_after_create: 30, delete_after_sleep: 20 });
});

test('update_network_policy selects the replacement deployment and clears connection data', async () => {
  const sandbox = createSandbox();
  sandbox._deployment_id = 'old-deployment';
  sandbox._domain = 'old.example.test';

  sandbox.api = {
    getService: async () => ({ latest_deployment_id: 'old-deployment' }),
    getDeployment: async () => ({ definition: { name: 'sandbox' } }),
    updateService: async () => ({ latest_deployment_id: 'new-deployment' }),
  };

  await sandbox.update_network_policy({ block_network: true });

  assert.equal(sandbox._deployment_id, 'new-deployment');
  assert.equal(sandbox._conn_info, undefined);
  assert.equal(sandbox._domain, undefined);
});

test('exec_stream emits output, exit, and end events', async (t) => {
  const sandbox = createSandbox();
  const bytes = new TextEncoder().encode(
    'event: output\ndata: {"stream":"stdout","data":"hello"}\n\n' +
      'event: complete\ndata: {"code":7,"error":true}\n\n',
  );

  t.mock.method(globalThis, 'fetch', async () => {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 17));
          controller.enqueue(bytes.slice(17));
          controller.close();
        },
      }),
      { status: 200 },
    );
  });

  const stream = sandbox.exec_stream('false');
  const stdout = new Promise((resolve) => stream.addEventListener('stdout', ({ data }) => resolve(data)));
  const exit = new Promise((resolve) => stream.addEventListener('exit', ({ data }) => resolve(data)));
  const end = new Promise((resolve) => stream.addEventListener('end', resolve));

  assert.deepEqual(await stdout, { stream: 'stdout', data: 'hello' });
  assert.deepEqual(await exit, { code: 7, error: true });
  await end;
});

test('exec_stream reports an initial HTTP error', async (t) => {
  const sandbox = createSandbox();
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'broken' }, 500));

  const stream = sandbox.exec_stream('echo test');
  const error = await new Promise((resolve) => stream.addEventListener('error', ({ data }) => resolve(data)));

  assert.ok(error instanceof SandboxServiceError);
});

test('process helpers reject executor error bodies', async () => {
  const sandbox = createSandbox();
  sandbox.request = async () => ({ success: false, error: 'cannot start process' });

  await assert.rejects(sandbox.launch_process('sleep 10'), /cannot start process/);
});

test('create supports an existing app and container overrides', async (t) => {
  const createServiceCalls = [];
  let deletedService;

  t.mock.method(KoyebApi.prototype, 'createService', async (body, query) => {
    createServiceCalls.push({ body, query });
    return { app_id: body.app_id, id: 'service-id', name: body.name };
  });
  t.mock.method(KoyebApi.prototype, 'createApp', async () => {
    throw new Error('createApp must not run');
  });
  t.mock.method(KoyebApi.prototype, 'deleteService', async (id) => {
    deletedService = id;
  });

  const sandbox = await Sandbox.create({
    api_token: 'token',
    app_id: 'existing-app',
    project_id: 'project-id',
    name: 'custom-runtime',
    wait_ready: false,
    enable_mesh: true,
    entrypoint: ['node'],
    command: 'server.js',
    args: ['--port', '3000'],
  });

  assert.equal(createServiceCalls.length, 2);
  assert.deepEqual(createServiceCalls[0].query, { dry_run: true });
  assert.deepEqual(createServiceCalls[1].body.definition.docker.entrypoint, ['node']);
  assert.equal(createServiceCalls[1].body.definition.docker.command, 'server.js');
  assert.deepEqual(createServiceCalls[1].body.definition.docker.args, ['--port', '3000']);
  assert.equal(createServiceCalls[1].body.definition.mesh, 'DEPLOYMENT_MESH_ENABLED');
  assert.equal(createServiceCalls[1].body.project_id, 'project-id');

  await sandbox.delete();
  assert.equal(deletedService, 'service-id');
});

test('create restores a full snapshot without a deployment definition', async (t) => {
  let createServiceBody;
  let createAppBody;

  t.mock.method(KoyebApi.prototype, 'createApp', async (body) => {
    createAppBody = body;
    return { id: 'app-id' };
  });
  t.mock.method(KoyebApi.prototype, 'createService', async (body) => {
    createServiceBody = body;
    return { app_id: body.app_id, id: 'service-id', name: body.name };
  });

  const snapshot = Snapshot.fromApi(
    {
      id: 'snapshot-id',
      project_id: 'project-id',
      type: 'INSTANCE_SNAPSHOT_TYPE_FULL',
    },
    'token',
    'snapshot-secret',
  );
  await snapshot.spawn({
    name: 'restored',
    wait_ready: false,
  });

  assert.equal(createServiceBody.instance_snapshot_id, 'snapshot-id');
  assert.equal(createServiceBody.definition, undefined);
  assert.equal(createServiceBody.project_id, 'project-id');
  assert.equal(createAppBody.project_id, 'project-id');
});

test('snapshot uses the running instance and maps API state', async () => {
  const sandbox = createSandbox();
  let createSnapshotBody;

  sandbox.api = {
    listInstances: async () => [{ id: 'instance-id' }],
    createInstanceSnapshot: async (body) => {
      createSnapshotBody = body;
      return {
        id: 'snapshot-id',
        name: body.name,
        service_id: 'service-id',
        type: body.type,
        status: 'INSTANCE_SNAPSHOT_STATUS_AVAILABLE',
      };
    },
  };

  const snapshot = await sandbox.snapshot('filesystem-snapshot', SnapshotType.FILESYSTEM, false);

  assert.deepEqual(createSnapshotBody, {
    instance_id: 'instance-id',
    name: 'filesystem-snapshot',
    type: 'INSTANCE_SNAPSHOT_TYPE_FILESYSTEM',
  });
  assert.equal(snapshot.id, 'snapshot-id');
  assert.equal(snapshot.status, SnapshotStatus.AVAILABLE);
});
