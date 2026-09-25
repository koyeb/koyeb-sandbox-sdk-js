import { Sandbox, ServicePool, claim, get_claim, wait_claim_ready } from '@koyeb/sandbox-sdk';

async function main() {
  // Spawn a pool, claim from it, run code, and clean up both.
  const pool = await ServicePool.create('example-pool', { size: 1, image: 'koyeb/sandbox:slim' });
  console.log(`✓ Created pool ${pool.id} (size ${pool.size})`);

  try {
    const claimed = await claim(pool.id);
    console.log(`✓ Claimed sandbox from pool`);
    console.log(`  Claim ID: ${claimed.claim_id}`);
    console.log(`  Request ID: ${claimed.request_id}`);
    console.log(`  Service ID: ${claimed.service_id}`);
    console.log(`  Prewarmed: ${claimed.prewarmed}`);

    const info = await get_claim(claimed.claim_id);
    console.log(`  Claim status: ${info.status}`);

    // Resolve the claimed service to a Sandbox up front, so the finally
    // block can clean it up even if the cold-path wait fails.
    const sandbox = await Sandbox.get_from_id(claimed.service_id);

    try {
      if (!claimed.prewarmed) {
        console.log('\nCold path: waiting for the sandbox service to become ready...');
        const ready = await wait_claim_ready(claimed, { timeout: 300, poll_interval: 2 });
        if (!ready) {
          throw new Error('Claimed sandbox did not become ready within 300 seconds');
        }
        console.log('  ✓ Sandbox service is ready');
      }

      const result = await sandbox.exec("echo 'Hello from a pooled sandbox!'");
      console.log(`\n  Sandbox output: ${result.stdout.trim()}`);
    } finally {
      // A claimed service is detached from the pool and owned by the caller:
      // delete it like any other sandbox once you are done with it.
      await sandbox.delete();
      console.log('\n✓ Deleted the claimed sandbox service');
    }
  } finally {
    await pool.delete();
    console.log('✓ Deleted the pool');
  }
}

main().catch(console.error);
