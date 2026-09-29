import assert from 'node:assert/strict';

import { Sandbox, ServicePool, claim, get_claim, wait_claim_ready } from '@koyeb/sandbox-sdk';

import { assertCommand, exampleName, requireApiToken, runExample } from './_helpers.js';

await runExample('pool claim', async () => {
  const apiToken = requireApiToken();
  const pool = await ServicePool.create(exampleName('claim-demo'), {
    size: 1,
    image: 'koyeb/sandbox:slim',
    api_token: apiToken,
  });

  try {
    const claimed = await claim(pool.id, { api_token: apiToken });
    assert.ok(claimed.claim_id);
    assert.ok(claimed.service_id);
    assert.ok(claimed.request_id);

    const info = await get_claim(claimed.claim_id, { api_token: apiToken });
    assert.equal(info.id, claimed.claim_id);

    const sandbox = await Sandbox.get_from_id(claimed.service_id, apiToken);
    try {
      if (!claimed.prewarmed) {
        assert.equal(await wait_claim_ready(claimed, { api_token: apiToken, timeout: 300, poll_interval: 2 }), true);
      }

      const result = await sandbox.exec("echo 'Hello from a claimed sandbox!'");
      assertCommand(result);
      assert.equal(result.stdout.trim(), 'Hello from a claimed sandbox!');

      const replay = await claim(pool.id, { request_id: claimed.request_id, api_token: apiToken });
      assert.equal(replay.service_id, claimed.service_id);
    } finally {
      await sandbox.delete();
    }
  } finally {
    await pool.delete();
  }
});
