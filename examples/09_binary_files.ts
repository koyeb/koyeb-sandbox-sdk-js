import assert from 'node:assert/strict';

import { runExample, withSandbox } from './_helpers.js';

await runExample('binary files', async () => {
  await withSandbox('binary-files', {}, async (sandbox) => {
    const binary = Buffer.from([0, 1, 2, 3, 255, 254, 253]);
    await sandbox.filesystem.write_file('/tmp/binary.bin.b64', binary.toString('base64'));
    const stored = await sandbox.filesystem.read_file('/tmp/binary.bin.b64');
    assert.deepEqual(Buffer.from(stored.content, 'base64'), binary);
  });
});
