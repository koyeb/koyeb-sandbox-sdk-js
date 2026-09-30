import assert from 'node:assert/strict';

import { ServicePool } from '@koyeb/sandbox-sdk';

import { exampleName, requireApiToken, runExample, sleep } from './_helpers.js';

await runExample('service pool lifecycle', async () => {
  const apiToken = requireApiToken();
  let pool: ServicePool | undefined;

  try {
    pool = await ServicePool.create(exampleName('my-pool'), {
      size: 1,
      region: process.env.KOYEB_SERVICE_POOL_REGION || 'nl-north-1',
      api_token: apiToken,
    });
    assert.ok(pool.id, 'Pool creation returned no id');

    const pools = await ServicePool.list({ api_token: apiToken });
    assert.ok(
      pools.some((candidate) => candidate.id === pool?.id),
      'Created pool is missing from the list',
    );

    const deadline = Date.now() + 300_000;
    while (pool.ready_count !== pool.size && Date.now() < deadline) {
      await sleep(2);
      pool = await pool.refresh();
      if (pool.status === 'ERROR') throw new Error('Pool entered ERROR before it became ready');
    }
    assert.equal(pool.ready_count, pool.size, 'Pool did not become ready within 300 seconds');

    pool = await pool.update({ size: 2 });
    pool = await pool.refresh();
    assert.equal(pool.size, 2);
  } finally {
    await pool?.delete();
  }
});
