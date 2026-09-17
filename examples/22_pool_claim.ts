import { Sandbox, claim, get_claim, wait_claim_ready } from '@koyeb/sandbox-sdk';

const poolId = process.argv[2] ?? process.env.KOYEB_POOL_ID;

async function main() {
  if (!poolId) {
    console.log('Skipping: pass a pool ID as argument or set KOYEB_POOL_ID to run this example.');
    return;
  }

  // The request id is generated once by the SDK and reused across internal
  // retries. Pass `request_id` explicitly to replay a previous claim: the
  // same (pool_id, request_id) pair always returns the same claim.
  const claimed = await claim(poolId);
  console.log(`✓ Claimed a sandbox from pool ${poolId}`);
  console.log(`  Claim ID: ${claimed.claim_id}`);
  console.log(`  Request ID: ${claimed.request_id}`);
  console.log(`  Service ID: ${claimed.service_id}`);
  console.log(`  Sandbox ID: ${claimed.sandbox_id ?? '(not returned)'}`);
  console.log(`  Prewarmed: ${claimed.prewarmed}`);

  const info = await get_claim(claimed.claim_id, { request_id: claimed.request_id });
  console.log(`  Claim status: ${info.status}`);

  let sandbox: Sandbox | undefined;

  try {
    if (!claimed.prewarmed) {
      console.log('\nCold path: waiting for the sandbox service to become ready...');
      const ready = await wait_claim_ready(claimed, { timeout: 300, poll_interval: 2 });
      if (!ready) {
        throw new Error('Claimed sandbox did not become ready within 300 seconds');
      }
      console.log('  ✓ Sandbox service is ready');
    }

    sandbox = await Sandbox.get_from_id(claimed.service_id);
    const result = await sandbox.exec("echo 'Hello from a pooled sandbox!'");
    console.log(`\n  Sandbox output: ${result.stdout.trim()}`);
  } finally {
    // A claimed service is detached from the pool and owned by the caller:
    // delete it like any other sandbox once you are done with it.
    if (sandbox) {
      await sandbox.delete();
      console.log('\n✓ Deleted the claimed sandbox service');
    }
  }
}

main().catch(console.error);
