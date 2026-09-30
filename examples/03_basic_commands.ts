import assert from 'node:assert/strict';

import { assertCommand, runExample, withSandbox } from './_helpers.js';

await runExample('basic commands', async () => {
  await withSandbox('basic-commands', {}, async (sandbox) => {
    let result = await sandbox.exec("echo 'Sandbox is ready!'");
    assertCommand(result);
    assert.equal(result.stdout.trim(), 'Sandbox is ready!');

    result = await sandbox.exec("python3 -c 'print(2 + 2)'");
    assertCommand(result);
    assert.equal(result.stdout.trim(), '4');

    result = await sandbox.exec('false');
    assert.notEqual(result.code, 0);
  });
});
