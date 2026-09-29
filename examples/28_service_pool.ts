import assert from 'node:assert/strict';

import { ServicePool } from '@koyeb/sandbox-sdk';

import { exampleName, requireApiToken, runExample } from './_helpers.js';

await runExample('service pool lifecycle', async () => {
  const apiToken = requireApiToken();
  let pool: ServicePool | undefined;

  try {
    pool = await ServicePool.create(exampleName('my-pool'), { size: 3, api_token: apiToken });
    assert.ok(pool.id, 'Pool creation returned no id');

    const pools = await ServicePool.list({ api_token: apiToken });
    assert.ok(
      pools.some((candidate) => candidate.id === pool?.id),
      'Created pool is missing from the list',
    );

    pool = await pool.update({ size: 5 });
    pool = await pool.refresh();
    assert.equal(pool.size, 5);
  } finally {
    await pool?.delete();
  }
});
