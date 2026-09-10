import assert from 'node:assert/strict';

import { runExample, withSandbox } from './_helpers.js';

await runExample('batch operations', async () => {
  await withSandbox('batch-operations', {}, async (sandbox) => {
    const files = [
      { path: '/tmp/file1.txt', content: 'one' },
      { path: '/tmp/file2.txt', content: 'two' },
      { path: '/tmp/file3.txt', content: 'three' },
    ];
    await sandbox.filesystem.write_files(files);
    const contents = await Promise.all(files.map(({ path }) => sandbox.filesystem.read_file(path)));
    assert.deepEqual(
      contents.map((file) => file.content),
      files.map((file) => file.content),
    );
  });
});
