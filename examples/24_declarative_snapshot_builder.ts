import assert from 'node:assert/strict';

import { Sandbox, Snapshot } from '@koyeb/sandbox-sdk';

import { exampleName, requireApiToken, runExample, sandboxOptions } from './_helpers.js';

await runExample('declarative snapshot builder', async () => {
  let snapshot: Snapshot | undefined;
  let first: Sandbox | undefined;
  let second: Sandbox | undefined;

  try {
    snapshot = await Sandbox.template(exampleName('python-template'), 'python:3.12', {
      workdir: '/workspace',
      api_token: requireApiToken(),
      project_id: process.env.KOYEB_PROJECT_ID || undefined,
    })
      .file('requirements.txt', 'requests\n')
      .run('pip install -r requirements.txt')
      .build(exampleName('python-template-snapshot'));

    assert.ok(snapshot.operations.some((operation) => operation.startsWith('create_file:')));
    [first, second] = await Promise.all([
      snapshot.spawn(sandboxOptions('snapshot-runner-1', { image: 'python:3.12', wait_ready: false })),
      snapshot.spawn(sandboxOptions('snapshot-runner-2', { image: 'python:3.12', wait_ready: false })),
    ]);
    assert.equal(await first.wait_ready(300), true);
    assert.equal(await second.wait_ready(300), true);
    assert.equal((await first.exec('python3 -c "import requests; print(\'OK\')"')).stdout.trim(), 'OK');
    assert.equal((await second.exec('python3 -c "import requests; print(\'OK\')"')).stdout.trim(), 'OK');
  } finally {
    await second?.delete();
    await first?.delete();
    await snapshot?.delete();
  }
});
