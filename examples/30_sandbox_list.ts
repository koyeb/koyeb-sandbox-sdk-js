import assert from 'node:assert/strict';

import { NoSandboxSecretError, Sandbox } from '@koyeb/sandbox-sdk';

import { assertCommand, requireApiToken, runExample, withSandbox } from './_helpers.js';

await runExample('sandbox list', async () => {
  const apiToken = requireApiToken();

  await withSandbox('list-demo', {}, async (sandbox) => {
    const handles = await Sandbox.list({
      api_token: apiToken,
      project_id: process.env.KOYEB_PROJECT_ID || undefined,
    });
    const handle = handles.find((candidate) => candidate.id === sandbox.id);
    assert.ok(handle, 'Created sandbox is missing from Sandbox.list()');

    await assert.rejects(handle.exec('echo hi'), NoSandboxSecretError);

    const connected = await Sandbox.get_from_id(handle.id, apiToken);
    const result = await connected.exec('echo hello from the list demo');
    assertCommand(result);
    assert.equal(result.stdout.trim(), 'hello from the list demo');
  });
});
