/**
 * Two sandboxes with different auto-delete lifecycles:
 * 1. delete_after_delay — deleted N seconds after creation.
 * 2. idle_timeout + delete_after_inactivity_delay — sleeps after idling, then deletes.
 */
import { KoyebApi, Sandbox } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);
const sandboxes: Sandbox[] = [];

async function serviceExists(serviceId: string): Promise<boolean> {
  try {
    await new KoyebApi(apiToken).getService(serviceId);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Sandbox 1: delete_after_delay (delete 60s after creation).
  console.log('--- SANDBOX 1: delete_after_delay (60s after creation) ---');
  const start1 = Date.now();
  const sandbox1 = await Sandbox.create({
    image: 'koyeb/sandbox:slim',
    name: `auto-delete-test-1-${suffix}`,
    wait_ready: true,
    api_token: apiToken,
    delete_after_delay: 60,
  });
  sandboxes.push(sandbox1);
  console.log(`✓ Created sandbox 1 in ${((Date.now() - start1) / 1000).toFixed(1)}s`);
  console.log(`  Service ID: ${sandbox1.id}`);

  const healthy1 = await sandbox1.is_healthy();
  if (!healthy1) throw new Error('Sandbox 1 should be healthy');
  console.log(`  ✓ ${(await sandbox1.exec("echo 'Sandbox 1 ready'")).stdout.trim()}`);

  // Sandbox 2: idle_timeout + delete_after_inactivity_delay.
  console.log('\n--- SANDBOX 2: idle_timeout + delete_after_inactivity_delay ---');
  const idleTimeout = 60; // sleep after 60s of inactivity
  const deleteAfterInactivity = 60; // delete 60s after sleep
  console.log(
    `  idle_timeout: ${idleTimeout}s, delete_after_inactivity_delay: ${deleteAfterInactivity}s`,
  );

  const start2 = Date.now();
  const sandbox2 = await Sandbox.create({
    image: 'koyeb/sandbox:slim',
    name: `auto-delete-test-2-${suffix}`,
    wait_ready: true,
    api_token: apiToken,
    idle_timeout: idleTimeout,
    delete_after_inactivity_delay: deleteAfterInactivity,
  });
  sandboxes.push(sandbox2);
  console.log(`✓ Created sandbox 2 in ${((Date.now() - start2) / 1000).toFixed(1)}s`);
  console.log(`  Service ID: ${sandbox2.id}`);

  const healthy2 = await sandbox2.is_healthy();
  if (!healthy2) throw new Error('Sandbox 2 should be healthy');
  console.log(`  ✓ ${(await sandbox2.exec("echo 'Sandbox 2 ready'")).stdout.trim()}`);

  // Wait for both auto-deletions (up to 10 minutes).
  console.log('\n--- WAITING FOR AUTO-DELETION ---');
  const waitStart = Date.now();
  const maxWait = 600;
  let deleted1 = false;
  let deleted2 = false;

  while (Date.now() - waitStart < maxWait * 1_000) {
    const elapsed = (Date.now() - waitStart) / 1_000;

    if (!deleted1 && !(await serviceExists(sandbox1.id))) {
      deleted1 = true;
      console.log(`  ✓ Sandbox 1 auto-deleted at ${elapsed.toFixed(1)}s`);
    }
    if (!deleted2 && !(await serviceExists(sandbox2.id))) {
      deleted2 = true;
      console.log(`  ✓ Sandbox 2 auto-deleted at ${elapsed.toFixed(1)}s`);
    }

    if (deleted1 && deleted2) {
      console.log('\n✓ Both sandboxes auto-deleted');
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
    console.log(`  ... still waiting (${elapsed.toFixed(0)}s elapsed)`);
  }

  throw new Error('Timeout waiting for auto-deletion');
}

async function cleanup() {
  // Manual cleanup only for sandboxes the platform has not deleted yet.
  for (const sandbox of sandboxes) {
    await sandbox.delete().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
