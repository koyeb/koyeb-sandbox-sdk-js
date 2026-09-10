import assert from 'node:assert/strict';

import { KoyebApi, Sandbox } from '@koyeb/sandbox-sdk';

import { exampleName, requireApiToken, runExample, sandboxOptions } from './_helpers.js';

await runExample('config files', async () => {
  const apiToken = requireApiToken();
  const api = new KoyebApi(apiToken);
  const secretName = exampleName('config-secret');
  const secretValue = 'secret-value-123';
  const secret = await api.createSecret({
    name: secretName,
    value: secretValue,
    project_id: process.env.KOYEB_PROJECT_ID || undefined,
  });
  let sandbox: Sandbox | undefined;

  try {
    sandbox = await Sandbox.create(
      sandboxOptions('config-files', {
        env: { X: '2', MY_SECRET: secret },
        config_files: {
          '/tmp/secret.txt': { name: secretName },
          '/tmp/interpolation.txt': '{{ X }}',
          '/tmp/restricted.txt': { content: 'owner-only', permissions: '0600' },
        },
      }),
    );
    assert.equal((await sandbox.exec('cat /tmp/secret.txt')).stdout.trim(), secretValue);
    assert.equal((await sandbox.exec('cat /tmp/interpolation.txt')).stdout.trim(), '2');
    assert.equal((await sandbox.exec("stat -c '%a' /tmp/restricted.txt")).stdout.trim(), '600');
    assert.equal((await sandbox.exec('printenv MY_SECRET')).stdout.trim(), secretValue);
  } finally {
    await sandbox?.delete();
    if (secret.id) await api.deleteSecret(secret.id);
  }
});
