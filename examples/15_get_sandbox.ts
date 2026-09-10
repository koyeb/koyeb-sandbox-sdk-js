import assert from 'node:assert/strict';

import { Sandbox } from '@koyeb/sandbox-sdk';

import { assertCommand, runExample, withSandbox } from './_helpers.js';

await runExample('get sandbox', async () => {
  await withSandbox('get-sandbox', {}, async (sandbox) => {
    const retrieved = await Sandbox.get_from_id(sandbox.id);
    assert.equal(retrieved.id, sandbox.id);
    assert.equal(retrieved.app_id, sandbox.app_id);
    assert.equal(await retrieved.is_healthy(), true);
    const result = await retrieved.exec('echo retrieved');
    assertCommand(result);
    assert.equal(result.stdout.trim(), 'retrieved');
  });
});
