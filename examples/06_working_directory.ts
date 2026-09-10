import assert from 'node:assert/strict';

import { assertCommand, runExample, withSandbox } from './_helpers.js';

await runExample('working directory', async () => {
  await withSandbox('working-directory', {}, async (sandbox) => {
    assertCommand(await sandbox.exec('mkdir -p /tmp/project/src'));
    assertCommand(await sandbox.exec(`echo 'print("hello")' > /tmp/project/src/main.py`));
    const pwd = await sandbox.exec('pwd', { cwd: '/tmp/project' });
    assertCommand(pwd);
    assert.equal(pwd.stdout.trim(), '/tmp/project');
    const file = await sandbox.exec('cat src/main.py', { cwd: '/tmp/project' });
    assertCommand(file);
    assert.match(file.stdout, /hello/);
  });
});
