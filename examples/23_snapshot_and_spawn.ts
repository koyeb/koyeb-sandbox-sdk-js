import assert from 'node:assert/strict';

import { Sandbox, Snapshot, SnapshotType } from '@koyeb/sandbox-sdk';

import { assertCommand, exampleName, runExample, sandboxOptions } from './_helpers.js';

await runExample('filesystem snapshot and spawn', async () => {
  let source: Sandbox | undefined;
  let restored: Sandbox | undefined;
  let snapshot: Snapshot | undefined;

  try {
    source = await Sandbox.create(sandboxOptions('snapshot-source', { image: 'python:3.12' }));
    await source.filesystem.mkdir('/workspace', true);
    await source.filesystem.write_file('/workspace/message.txt', 'Hello from snapshot!');
    assertCommand(await source.exec('pip install requests', { timeout: 300 }), 'install requests');

    snapshot = await source.snapshot(exampleName('filesystem-snapshot'), SnapshotType.FILESYSTEM);
    restored = await snapshot.spawn(
      sandboxOptions('snapshot-restored', {
        image: 'python:3.12',
        instance_type: 'nano',
        env: { SPAWNED_FROM_SNAPSHOT: 'true' },
      }),
    );

    assert.equal((await restored.exec('cat /workspace/message.txt')).stdout.trim(), 'Hello from snapshot!');
    assert.equal((await restored.exec('python3 -c "import requests; print(\'OK\')"')).stdout.trim(), 'OK');
    assert.equal((await restored.exec('echo "$SPAWNED_FROM_SNAPSHOT"')).stdout.trim(), 'true');
  } finally {
    await restored?.delete();
    await snapshot?.delete();
    await source?.delete();
  }
});
