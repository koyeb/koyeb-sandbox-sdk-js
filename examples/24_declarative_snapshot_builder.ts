/**
 * Declarative snapshot builder: declare files and commands, build the snapshot
 * once, and spawn several sandboxes from it.
 */
import { Sandbox } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);

async function main() {
  let snapshot: Awaited<ReturnType<typeof buildSnapshot>> | undefined;
  let runner1: Sandbox | undefined;
  let runner2: Sandbox | undefined;

  try {
    console.log('✓ Building declarative snapshot...');
    snapshot = await buildSnapshot();
    for (const op of snapshot.operations) {
      console.log(`    - ${op}`);
    }
    console.log(`  ✓ Snapshot built: ${snapshot.name}`);

    // Spawn multiple sandboxes from the same snapshot in parallel.
    console.log('✓ Spawning sandboxes from snapshot...');
    console.log('  - Spawning runner1...');
    console.log('  - Spawning runner2...');
    [runner1, runner2] = await Promise.all([
      snapshot.spawn(`test-suite-1-${suffix}`, { image: 'python:3.12', wait_ready: false, api_token: apiToken! }),
      snapshot.spawn(`test-suite-2-${suffix}`, { image: 'python:3.12', wait_ready: false, api_token: apiToken! }),
    ]);
    console.log(`  ✓ Runner1 spawned: ${runner1.name}`);
    console.log(`  ✓ Runner2 spawned: ${runner2.name}`);

    console.log('✓ Waiting for runners to be ready...');
    const ready = await Promise.all([runner1.wait_ready(300), runner2.wait_ready(300)]);
    if (!ready.every(Boolean)) {
      throw new Error('A runner did not become ready within 300 seconds');
    }

    // Both runners share the same pre-installed environment.
    console.log('✓ Verifying runners see the pre-installed packages...');
    for (const runner of [runner1, runner2]) {
      const result = await runner.exec("python3 -c \"import requests; print('OK')\"");
      if (result.stdout.trim() !== 'OK') {
        throw new Error(`${runner.name} is missing the requests package: ${result.stderr}`);
      }
      console.log(`  ✓ ${runner.name} has the requests package`);
    }
  } finally {
    await runner1?.delete().catch(() => {});
    await runner2?.delete().catch(() => {});
    await snapshot?.delete().catch(() => {});
  }
}

function buildSnapshot() {
  return Sandbox.template(`ci-environment-${suffix}`, 'python:3.12', {
    workdir: '/workspace',
    api_token: apiToken,
  })
    .file('requirements.txt', 'requests')
    .run('pip install -r requirements.txt')
    .build(`python-ci-env-${suffix}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
