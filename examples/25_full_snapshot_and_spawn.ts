/**
 * FULL snapshot: filesystem AND process state. A daemon started before the
 * snapshot keeps running in sandboxes spawned from it.
 */
import { Sandbox, SandboxTimeoutError } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);

async function main() {
  let sbx: Sandbox | undefined;
  let sbx2: Sandbox | undefined;
  let snapshot: Awaited<ReturnType<typeof takeSnapshot>> | undefined;

  try {
    console.log('✓ Creating sandbox...');
    sbx = await Sandbox.create({
      image: 'python:3.12',
      name: `full-snapshot-and-spawn-${suffix}`,
      wait_ready: true,
      api_token: apiToken,
    });
    console.log(`  ✓ Sandbox created: ${sbx.name}`);

    console.log('✓ Creating files...');
    await sbx.filesystem.mkdir('/workspace');
    await sbx.filesystem.write_file('/workspace/requirements.txt', 'requests\n');
    console.log('  ✓ Files created');

    console.log('✓ Installing packages...');
    await sbx.exec('pip3 install requests');
    console.log('  ✓ Packages installed');

    // Start an HTTP daemon in the background; the FULL snapshot captures it running.
    console.log('✓ Running HTTP daemon server on port 8000...');
    await sbx.exec('python3 -m http.server', { timeout: 2 }).catch((error) => {
      if (!(error instanceof SandboxTimeoutError)) {
        throw error;
      }
    });
    console.log('  ✓ Started HTTP daemon server on port 8000');

    console.log('✓ Creating full snapshot...');
    snapshot = await takeSnapshot(sbx);
    console.log(`  ✓ Full snapshot created: ${snapshot.name}`);

    console.log('✓ Spawning sandbox from full snapshot with different instance type...');
    sbx2 = await snapshot.spawn(`test-runner-full-${suffix}`, {
      image: 'python:3.12',
      instance_type: 'nano',
      wait_ready: false,
      api_token: apiToken,
    });
    console.log(`  ✓ Sandbox spawned: ${sbx2.name}`);

    console.log('✓ Waiting for spawned sandbox to be ready...');
    await sbx2.wait_ready(300);
    console.log('  ✓ Sandbox is ready');

    console.log('✓ Verifying full snapshot...');

    const imported = await sbx2.exec("python3 -c \"import requests; print('OK')\"");
    if (imported.stdout.trim() !== 'OK') {
      throw new Error(`Package not found: ${imported.stdout}`);
    }
    console.log('  ✓ Python package installed preserved');

    // The process state is preserved: the daemon from the original sandbox is live.
    const served = await sbx2.exec('curl localhost:8000');
    if (!served.stdout.includes('Directory listing for /')) {
      throw new Error('HTTP server launched in original sandbox is not running anymore');
    }
    console.log('  ✓ Daemon HTTP server launched on initial sandbox is still running');
  } finally {
    await sbx2?.delete().catch(() => {});
    await snapshot?.delete().catch(() => {});
    await sbx?.delete().catch(() => {});
  }
}

function takeSnapshot(sbx: Sandbox) {
  return sbx.snapshot(`python-full-snapshot-${suffix}`, { snapshot_type: 'FULL' });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
