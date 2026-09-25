/**
 * Create a sandbox, snapshot its filesystem, and spawn a new sandbox from it.
 */
import { Sandbox, Snapshot } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);

async function main() {
  let sbx: Sandbox | undefined;
  let sbx2: Sandbox | undefined;
  let snapshot: Snapshot | undefined;

  try {
    console.log('✓ Creating sandbox...');
    sbx = await Sandbox.create({
      image: 'node:22-slim',
      name: `snapshot-and-spawn-${suffix}`,
      wait_ready: true,
      api_token: apiToken,
    });
    console.log(`  ✓ Sandbox created: ${sbx.name}`);

    // Create files to verify filesystem preservation.
    console.log('✓ Creating files...');
    await sbx.filesystem.mkdir('/workspace');
    await sbx.filesystem.write_file('/workspace/test_file.txt', 'Hello from snapshot!');
    await sbx.filesystem.write_file('/workspace/requirements.txt', 'requests\npytest\n');
    console.log('  ✓ Files created');

    console.log('✓ Installing packages...');
    await sbx.exec('cd /workspace && npm install axios');
    console.log('  ✓ Packages installed');

    console.log('✓ Creating snapshot...');
    snapshot = await sbx.snapshot(`node-with-deps-${suffix}`, { snapshot_type: 'FILESYSTEM' });
    console.log(`  ✓ Snapshot created: ${snapshot.name}`);

    // Spawn with a different instance type and some env.
    console.log('✓ Spawning sandbox from snapshot with different instance type...');
    sbx2 = await snapshot.spawn(`test-runner-${suffix}`, {
      image: 'node:22-slim',
      instance_type: 'nano',
      env: { SPAWNED_FROM_SNAPSHOT: 'true' },
      wait_ready: false,
      api_token: apiToken,
    });
    console.log(`  ✓ Sandbox spawned: ${sbx2.name}`);

    console.log('✓ Waiting for spawned sandbox to be ready...');
    await sbx2.wait_ready(300);
    console.log('  ✓ Sandbox is ready');

    console.log('✓ Verifying filesystem is preserved from snapshot...');
    const file = await sbx2.exec('cat /workspace/test_file.txt');
    if (file.stdout.trim() !== 'Hello from snapshot!') {
      throw new Error(`File content mismatch: ${file.stdout}`);
    }
    console.log('  ✓ Custom file preserved');

    const imported = await sbx2.exec("node -e \"require('axios'); console.log('OK')\"", { cwd: '/workspace' });
    if (imported.stdout.trim() !== 'OK') {
      throw new Error(`Package not pre-installed: ${imported.stdout}`);
    }
    console.log('  ✓ Packages pre-installed');
  } finally {
    await sbx2?.delete().catch(() => {});
    await snapshot?.delete().catch(() => {});
    await sbx?.delete().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
