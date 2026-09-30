import assert from 'node:assert/strict';

import { assertCommand, runExample, withSandbox } from './_helpers.js';

await runExample('create sandbox', async () => {
  await withSandbox('create-sandbox', {}, async (sandbox) => {
    assert.ok(sandbox.id);
    assert.equal(await sandbox.is_healthy(), true);
    const result = await sandbox.exec("echo 'Sandbox is ready!'");
    assertCommand(result);
    assert.equal(result.stdout.trim(), 'Sandbox is ready!');
  });
});
