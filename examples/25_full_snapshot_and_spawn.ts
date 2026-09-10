import assert from 'node:assert/strict';

import { Sandbox, Snapshot, SnapshotType } from '@koyeb/sandbox-sdk';

import { assertCommand, exampleName, runExample, sandboxOptions, sleep } from './_helpers.js';

await runExample('full snapshot and spawn', async () => {
  let source: Sandbox | undefined;
  let restored: Sandbox | undefined;
  let snapshot: Snapshot | undefined;

  try {
    source = await Sandbox.create(sandboxOptions('full-snapshot-source', { image: 'python:3.12' }));
    await source.filesystem.write_file('/tmp/index.html', 'preserved process');
    assert.ok(await source.launch_process('python3 -m http.server 8000', { cwd: '/tmp' }));
    await sleep(2);
    assertCommand(await source.exec('curl --fail localhost:8000'));

    snapshot = await source.snapshot(exampleName('full-snapshot'), SnapshotType.FULL);
    restored = await snapshot.spawn(sandboxOptions('full-snapshot-restored', { wait_ready: false }));
    assert.equal(await restored.wait_ready(300), true);
    const response = await restored.exec('curl --fail localhost:8000');
    assertCommand(response);
    assert.match(response.stdout, /preserved process/);
  } finally {
    await restored?.delete();
    await snapshot?.delete();
    await source?.delete();
  }
});
