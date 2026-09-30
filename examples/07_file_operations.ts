import assert from 'node:assert/strict';

import { assertCommand, runExample, withSandbox } from './_helpers.js';

await runExample('file operations', async () => {
  await withSandbox('file-operations', {}, async (sandbox) => {
    const content = 'Hello, Koyeb Sandbox!\nThis is a test file.';
    await sandbox.filesystem.write_file('/tmp/hello.txt', content);
    assert.equal((await sandbox.filesystem.read_file('/tmp/hello.txt')).content, content);

    await sandbox.filesystem.write_file('/tmp/script.py', "#!/usr/bin/env python3\nprint('Hello from Python!')\n");
    assertCommand(await sandbox.exec('chmod +x /tmp/script.py'));
    const result = await sandbox.exec('/tmp/script.py');
    assertCommand(result);
    assert.equal(result.stdout.trim(), 'Hello from Python!');
  });
});
