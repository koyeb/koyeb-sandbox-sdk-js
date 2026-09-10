import assert from 'node:assert/strict';

import { EgressPolicyError, Sandbox } from '@koyeb/sandbox-sdk';

import { assertCommand, retry, runExample, sandboxOptions } from './_helpers.js';

const probe = 'python3 -c "import urllib.request; urllib.request.urlopen(\'https://example.com\', timeout=10)"';

await runExample('egress policy', async () => {
  await assert.rejects(
    Sandbox.create(sandboxOptions('invalid-egress', { block_network: true, outbound_allowlist: ['1.1.1.1'] })),
    EgressPolicyError,
  );

  const sandbox = await Sandbox.create(sandboxOptions('egress-policy', { block_network: true }));
  try {
    assert.notEqual((await sandbox.exec(probe)).code, 0);

    await sandbox.update_network_policy();
    assert.equal(await sandbox.wait_ready(300), true);
    const allowed = await retry(async () => {
      const result = await sandbox.exec(probe);
      if (result.code !== 0) throw new Error(result.stderr);
      return result;
    });
    assertCommand(allowed);
  } finally {
    await sandbox.delete();
  }
});
