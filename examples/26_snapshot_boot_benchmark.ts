import assert from 'node:assert/strict';

import { Sandbox, Snapshot, SnapshotType } from '@koyeb/sandbox-sdk';

import { assertCommand, exampleName, runExample, sandboxOptions } from './_helpers.js';

const sizeMb = Number(process.env.KOYEB_SNAPSHOT_BENCHMARK_SIZE_MB ?? 10);
const boots = Number(process.env.KOYEB_SNAPSHOT_BENCHMARK_BOOTS ?? 1);

await runExample('snapshot boot benchmark', async () => {
  for (const snapshotType of [SnapshotType.FILESYSTEM, SnapshotType.FULL]) {
    let builder: Sandbox | undefined;
    let snapshot: Snapshot | undefined;
    const restored: Sandbox[] = [];

    try {
      builder = await Sandbox.create(sandboxOptions(`benchmark-${snapshotType}`, { image: 'python:3.12' }));
      assertCommand(
        await builder.exec(`dd if=/dev/zero of=/tmp/benchmark.bin bs=1M count=${sizeMb}`, { timeout: 300 }),
        'create benchmark data',
      );
      if (snapshotType === SnapshotType.FULL) {
        assert.ok(await builder.launch_process('sleep 3600'));
      }

      snapshot = await builder.snapshot(exampleName(`benchmark-${snapshotType}`), snapshotType, true, 1800);
      const durations: number[] = [];
      for (let index = 0; index < boots; index++) {
        const startedAt = performance.now();
        const restoredSandbox: Sandbox = await snapshot.spawn(
          sandboxOptions(`benchmark-${snapshotType}-${index}`, {
            image: 'python:3.12',
            wait_ready: false,
          }),
        );
        restored.push(restoredSandbox);
        assert.equal(await restoredSandbox.wait_ready(300), true);
        assert.equal(await restoredSandbox.filesystem.exists('/tmp/benchmark.bin'), true);
        durations.push(performance.now() - startedAt);
      }

      assert.equal(durations.length, boots);
      console.log(`${snapshotType}: ${durations.map((value) => `${(value / 1000).toFixed(2)}s`).join(', ')}`);
    } finally {
      await Promise.allSettled(restored.map((sandbox) => sandbox.delete()));
      await snapshot?.delete();
      await builder?.delete();
    }
  }
});
