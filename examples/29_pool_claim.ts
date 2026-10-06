/**
 * Pool claims: spawn a pool, claim a member, run code in it, clean up both.
 *
 * A claim hands out a pre-warmed sandbox when one is ready (prewarmed) or
 * cold-starts a service on demand. The claimed sandbox is detached from the
 * pool and owned by the caller — delete it like any other sandbox.
 */
import { randomUUID } from 'node:crypto';

import { Sandbox, ServicePool, claim, get_claim, wait_claim_ready } from '@koyeb/sandbox-sdk';

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
  const poolName = `example-pool-${randomUUID().slice(0, 8)}`;

  // Spawn a pool, claim from it, run code, and clean up both.
  const pool = await ServicePool.create(poolName, { size: 1, image: 'koyeb/sandbox:slim' });
  console.log(`✓ Created pool ${pool.id} (size ${pool.size})`);
  check(Boolean(pool.id), 'pool creation returned no id');

  try {
    const claimed = await claim(pool.id);
    console.log(`✓ Claimed sandbox from pool`);
    console.log(`  Claim ID: ${claimed.claim_id}`);
    console.log(`  Request ID: ${claimed.request_id}`);
    console.log(`  Service ID: ${claimed.service_id}`);
    console.log(`  Prewarmed: ${claimed.prewarmed}`);
    check(Boolean(claimed.claim_id), 'claim returned no claim_id');
    check(Boolean(claimed.service_id), 'claim returned no service_id');

    const info = await get_claim(claimed.claim_id);
    console.log(`  Claim status: ${info.status}`);
    check(Boolean(info.status), 'claim get returned no status');

    try {
      if (!claimed.prewarmed) {
        console.log('\nCold path: waiting for the sandbox service to become ready...');
        const ready = await wait_claim_ready(claimed, { timeout: 300, poll_interval: 2 });
        if (!ready) {
          throw new Error('Claimed sandbox did not become ready within 300 seconds');
        }
        console.log('  ✓ Sandbox service is ready');
      }

      // Resolve AFTER the cold path settles: the claimed service's
      // deployment (and its platform-minted SANDBOX_SECRET) is created
      // asynchronously — resolving before the wait races it and fails.
      const sandbox = await Sandbox.get_from_id(claimed.service_id);

      const result = await sandbox.exec("echo 'Hello from a pooled sandbox!'");
      console.log(`\n  Sandbox output: ${result.stdout.trim()}`);
      check(result.stdout.trim() === 'Hello from a pooled sandbox!', 'unexpected exec output');
    } finally {
      // A claimed service is detached from the pool and owned by the caller:
      // delete it like any other sandbox once you are done with it. Resolve
      // at teardown so a failed cold path still cleans up best-effort.
      await Sandbox.get_from_id(claimed.service_id)
        .then((s) => s.delete())
        .catch(() => {});
      console.log('\n✓ Deleted the claimed sandbox service');
    }
  } finally {
    // Deleting fences the pool until outstanding claims drain; best-effort
    // cleanup never fails a successful run.
    try {
      await pool.delete();
      console.log('✓ Deleted the pool');
    } catch (error) {
      console.error(`⚠ Could not delete pool ${pool.id}: ${error}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
