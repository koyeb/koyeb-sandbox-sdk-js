import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'example-sandbox' });

async function main() {
  console.log(`✓ Created sandbox: ${sandbox.name}`);
  console.log(`  Service ID: ${sandbox.service_id}`);
  console.log(`  App ID: ${sandbox.app_id}`);

  const result = await sandbox.exec("echo 'Hello from original sandbox!'");
  console.log(`  Original sandbox output: ${result.stdout}`);

  console.log('\nRetrieving sandbox by service ID...');
  const sandboxFromId = await Sandbox.get_from_id(sandbox.id);

  console.log(`✓ Retrieved sandbox: ${sandboxFromId.name}`);
  console.log(`  Service ID: ${sandboxFromId.service_id}`);
  console.log(`  App ID: ${sandboxFromId.app_id}`);

  if (sandbox.id !== sandboxFromId.id) {
    throw new Error('Sandbox IDs should match!');
  }
  console.log('  ✓ Confirmed: Same sandbox retrieved');

  const healthy = await sandboxFromId.is_healthy();
  console.log(`  Healthy: ${healthy}`);

  if (healthy) {
    const result = await sandboxFromId.exec("echo 'Hello from retrieved sandbox!'");
    console.log(`  Retrieved sandbox output: ${result.stdout}`);
  }
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
