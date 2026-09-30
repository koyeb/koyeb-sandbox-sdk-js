import assert from 'node:assert/strict';

import { runExample, withSandbox } from './_helpers.js';

await runExample('file manipulation', async () => {
  await withSandbox('file-manipulation', {}, async (sandbox) => {
    const fs = sandbox.filesystem;
    await fs.write_file('/tmp/file.txt', 'content');
    await fs.rename_file('/tmp/file.txt', '/tmp/renamed file.txt');
    assert.equal(await fs.exists('/tmp/renamed file.txt'), true);
    assert.equal((await fs.read_file('/tmp/renamed file.txt')).content, 'content');
    await fs.rm('/tmp/renamed file.txt');
    assert.equal(await fs.exists('/tmp/renamed file.txt'), false);

    await fs.mkdir('/tmp/test dir/child', true);
    await fs.rm('/tmp/test dir', true);
    assert.equal(await fs.exists('/tmp/test dir'), false);
  });
});
