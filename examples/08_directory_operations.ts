import assert from 'node:assert/strict';

import { runExample, withSandbox } from './_helpers.js';

await runExample('directory operations', async () => {
  await withSandbox('directory-operations', {}, async (sandbox) => {
    const fs = sandbox.filesystem;
    await fs.mkdir('/tmp/project/src/utils', true);
    await fs.write_file('/tmp/project/src/main.py', "print('Hello')");
    await fs.write_file('/tmp/project/README.md', '# Project');

    const contents = await fs.list_dir('/tmp/project');
    assert.ok(contents.includes('src'));
    assert.ok(contents.includes('README.md'));
    assert.equal(await fs.exists('/tmp/project'), true);
    assert.equal(await fs.is_dir('/tmp/project'), true);
    assert.equal(await fs.is_file('/tmp/project/src/main.py'), true);
  });
});
