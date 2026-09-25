/**
 * Create an app first, then create a sandbox inside it with app_id.
 */
import { KoyebApi, Sandbox } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);

async function main() {
  const api = new KoyebApi(apiToken);

  // Step 1: create the app that will host the sandbox.
  console.log('--- CREATING APP ---');
  const appName = `my-sandbox-app-${Math.floor(Date.now() / 1000)}`;
  const app = await api.createApp({ name: appName });
  console.log(`  App created: ${app.id} (${app.name})`);

  try {
    // Step 2: create the sandbox inside the existing app.
    console.log('\n--- CREATING SANDBOX WITH EXISTING APP ---');
    const sandbox = await Sandbox.create({
      image: 'koyeb/sandbox:slim',
      name: `sandbox-in-existing-app-${suffix}`,
      wait_ready: true,
      api_token: apiToken,
      app_id: app.id!,
    });
    console.log(`  Service ID: ${sandbox.id}`);
    console.log(`  App ID: ${sandbox.app_id}`);

    if (sandbox.app_id !== app.id) {
      throw new Error('Sandbox should use the provided app_id');
    }
    console.log('  Verified: sandbox is using the existing app');

    // Step 3: use it.
    console.log('\n--- TESTING SANDBOX ---');
    console.log(`  Healthy: ${await sandbox.is_healthy()}`);
    const result = await sandbox.exec("echo 'Hello from sandbox in existing app!'");
    console.log(`  Output: ${result.stdout.trim()}`);

    console.log('\nDemo completed successfully!');
  } finally {
    // Deleting the app tears down the sandbox service with it.
    console.log('\nCleaning up...');
    await api.deleteApp(app.id!).catch((error) => console.error(`Error deleting app: ${error}`));
    console.log('  Deleted app');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
