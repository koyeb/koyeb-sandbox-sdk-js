/**
 * Service pool lifecycle: create, list, update, refresh, and delete a pool.
 *
 * A pool keeps a target number of warm sandboxes so claiming (see
 * examples/29_pool_claim.ts) hands out a pre-provisioned service instead of
 * provisioning one on demand.
 */
import { randomUUID } from 'node:crypto';

import { ServicePool } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('KOYEB_API_TOKEN is not set');
  process.exit(1);
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Example failed: ${message}`);
  }
}

async function main() {
  // Use a unique name so concurrent or repeated runs don't collide on the
  // server-side unique (name, workspace) index.
  const poolName = `my-pool-${randomUUID().slice(0, 8)}`;

  // Create a pool of 3 warm sandboxes. Definition options mirror
  // Sandbox.create (image, instance_type, env, region, ...).
  const pool = await ServicePool.create(poolName, { size: 3, api_token: apiToken });
  console.log(`✓ Created ${pool}`);
  check(Boolean(pool.id), 'pool creation returned no id');

  try {
    // List every pool the caller can see.
    const pools = await ServicePool.list({ api_token: apiToken });
    console.log(`✓ Listed ${pools.length} pool(s)`);
    check(pools.some((p) => p.id === pool.id), 'created pool missing from list');

    // Update the pool's target size.
    await pool.update({ size: 5 });
    console.log('✓ Updated: size=5');

    // Refresh re-fetches the pool (status, ready_count, ...).
    await pool.refresh();
    console.log(`✓ Refreshed, ready_count=${pool.ready_count}, status=${pool.status}`);
    check(pool.size === 5, `expected size 5 after update, got ${String(pool.size)}`);
  } finally {
    // Deleting fences the pool until outstanding claims drain.
    await pool.delete().catch(() => {});
    console.log('✓ Deleted');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
