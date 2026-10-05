/**
 * Create a single sandbox with the auto-delete lifecycle and wait for the platform to delete it.
 */
import { KoyebApi, Sandbox } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);

async function serviceExists(serviceId: string): Promise<boolean> {
  try {
    await new KoyebApi(apiToken).getService(serviceId);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const deleteAfterDelay = 60; // seconds after creation

  console.log(`→ Creating sandbox with auto-delete (delete_after_delay: ${deleteAfterDelay}s)...`);
  const createStart = Date.now();
  const sandbox = await Sandbox.create({
    image: 'koyeb/sandbox:slim',
    name: `auto-delete-test-simple-${suffix}`,
    wait_ready: true,
    api_token: apiToken,
    delete_after_delay: deleteAfterDelay,
  });
  console.log(`✓ Created in ${((Date.now() - createStart) / 1000).toFixed(1)}s`);
  console.log(`  Service ID: ${sandbox.id}`);

  console.log('\n→ Verifying sandbox is healthy...');
  const healthy = await sandbox.is_healthy();
  if (!healthy) throw new Error('Sandbox should be healthy');
  const result = await sandbox.exec("echo 'Sandbox ready'");
  console.log(`  ✓ ${result.stdout.trim()}`);

  // Wait for the platform to auto-delete the service.
  console.log('\n→ Waiting for sandbox to be auto-deleted...');
  const start = Date.now();
  const timeout = 300;

  while (Date.now() - start < timeout * 1_000) {
    if (!(await serviceExists(sandbox.id))) {
      console.log(`✓ Sandbox was auto-deleted after ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    console.log(`  ... still waiting (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
  }

  throw new Error('Timeout waiting for sandbox to be deleted');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
