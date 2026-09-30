import assert from 'node:assert/strict';

import { SandboxCommandError } from '@koyeb/sandbox-sdk';

import { runExample, withSandbox } from './_helpers.js';

await runExample('raise on command error', async () => {
  await withSandbox('raise-demo', {}, async (sandbox) => {
    const result = await sandbox.exec('ls /definitely-missing');
    assert.notEqual(result.code, 0, 'The default command result must report failure');

    let commandError: SandboxCommandError | undefined;
    try {
      await sandbox.exec('ls /definitely-missing', { raise_on_error: true });
    } catch (error) {
      assert.ok(error instanceof SandboxCommandError);
      commandError = error;
    }

    assert.ok(commandError, 'raise_on_error must raise SandboxCommandError');
    assert.notEqual(commandError.result.code, 0);
  });
});
