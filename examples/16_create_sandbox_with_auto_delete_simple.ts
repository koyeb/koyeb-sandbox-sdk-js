import assert from 'node:assert/strict';

import { KoyebApi, Sandbox } from '@koyeb/sandbox-sdk';

import { requireApiToken, runExample, sandboxOptions, sleep } from './_helpers.js';

await runExample('automatic deletion', async () => {
  const delay = Number(process.env.KOYEB_AUTO_DELETE_DELAY ?? 60);
  const api = new KoyebApi(requireApiToken());
  let sandbox: Sandbox | undefined;

  try {
    sandbox = await Sandbox.create(sandboxOptions('auto-delete', { delete_after_delay: delay }));
    assert.equal(await sandbox.is_healthy(), true);
    const serviceId = sandbox.id;
    const deadline = Date.now() + (delay + 180) * 1_000;
    let exists = true;

    while (exists && Date.now() < deadline) {
      await sleep(5);
      try {
        await api.getService(serviceId);
      } catch {
        exists = false;
      }
    }

    assert.equal(exists, false, `Sandbox was not deleted after ${delay} seconds`);
    sandbox = undefined;
  } finally {
    await sandbox?.delete().catch(() => undefined);
  }
});
