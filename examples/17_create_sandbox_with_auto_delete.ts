import assert from 'node:assert/strict';

import { KoyebApi, Sandbox } from '@koyeb/sandbox-sdk';

import { requireApiToken, runExample, sandboxOptions } from './_helpers.js';

await runExample('lifecycle updates', async () => {
  const api = new KoyebApi(requireApiToken());
  const sandbox = await Sandbox.create(
    sandboxOptions('lifecycle-update', {
      delete_after_delay: 300,
      delete_after_inactivity_delay: 300,
    }),
  );

  try {
    let service = await api.getService(sandbox.id);
    assert.equal(service.life_cycle?.delete_after_create, 300);
    assert.equal(service.life_cycle?.delete_after_sleep, 300);

    await sandbox.update_lifecycle({ delete_after_delay: 600 });
    service = await api.getService(sandbox.id);
    assert.equal(service.life_cycle?.delete_after_create, 600);
    assert.equal(service.life_cycle?.delete_after_sleep, 300);
  } finally {
    await sandbox.delete();
  }
});
