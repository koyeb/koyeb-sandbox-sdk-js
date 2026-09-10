import assert from 'node:assert/strict';

import { KoyebApi, Sandbox } from '@koyeb/sandbox-sdk';

import { exampleName, requireApiToken, runExample, sandboxOptions } from './_helpers.js';

await runExample('existing app', async () => {
  const apiToken = requireApiToken();
  const api = new KoyebApi(apiToken);
  const app = await api.createApp({
    name: exampleName('sandbox-example-app'),
    project_id: process.env.KOYEB_PROJECT_ID || undefined,
  });
  assert.ok(app.id);
  let sandbox: Sandbox | undefined;

  try {
    sandbox = await Sandbox.create(sandboxOptions('existing-app', { app_id: app.id }));
    assert.equal(sandbox.app_id, app.id);
    assert.equal(await sandbox.is_healthy(), true);
    assert.equal((await sandbox.exec('echo existing-app')).stdout.trim(), 'existing-app');
  } finally {
    await sandbox?.delete();
    await api.deleteApp(app.id);
  }
});
