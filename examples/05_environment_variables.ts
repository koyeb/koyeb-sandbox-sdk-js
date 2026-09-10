import assert from 'node:assert/strict';

import { KoyebApi, Sandbox } from '@koyeb/sandbox-sdk';

import { exampleName, requireApiToken, runExample, sandboxOptions } from './_helpers.js';

await runExample('environment variables', async () => {
  const apiToken = requireApiToken();
  const api = new KoyebApi(apiToken);
  const secretName = exampleName('example-secret');
  const secretValue = 'secret-value-123';
  const secret = await api.createSecret({
    name: secretName,
    value: secretValue,
    project_id: process.env.KOYEB_PROJECT_ID || undefined,
  });
  let sandbox: Sandbox | undefined;

  try {
    sandbox = await Sandbox.create(
      sandboxOptions('environment-variables', {
        env: { SECRET_VAL: secret, X: '2', Y: '{{ X }}' },
      }),
    );
    assert.equal((await sandbox.exec('echo "$SECRET_VAL"')).stdout.trim(), secretValue);
    assert.equal((await sandbox.exec('echo "$X"')).stdout.trim(), '2');
    assert.equal((await sandbox.exec('echo "$Y"')).stdout.trim(), '2');
  } finally {
    await sandbox?.delete();
    if (secret.id) await api.deleteSecret(secret.id);
  }
});
