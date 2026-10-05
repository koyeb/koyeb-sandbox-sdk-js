/**
 * Snapshot boot benchmark: build FILESYSTEM and FULL snapshots of controlled
 * sizes, boot N sandboxes from each, and report boot-time statistics to the
 * console and a CSV file.
 *
 *   npx tsx examples/26_snapshot_boot_benchmark.ts -- --fs-sizes 10,100 --boots 3
 */
import { writeFile } from 'node:fs/promises';

import { Sandbox, Snapshot } from '@koyeb/sandbox-sdk';

const args = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const option = (name: string, fallback: string) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const FS_SIZES = option('fs-sizes', '10,100,1000').split(',').map(Number);
const FULL_SIZES = option('full-sizes', '10,100,1000').split(',').map(Number);
const BOOTS = Number(option('boots', '5'));
const CSV = option('csv', 'snapshot_boot_benchmark.csv');
const SKIP_FULL = args.has('--skip-full');
const SKIP_FS = args.has('--skip-fs');

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);

/** dd a file of the given size, then sync it out of the page cache. */
async function createFileOfSize(sbx: Sandbox, path: string, sizeMb: number) {
  const result = await sbx.exec(`dd if=/dev/zero of=${path} bs=1M count=${sizeMb} 2>&1 && sync ${path}`);
  if (result.code !== 0) {
    throw new Error(`Failed to create ${sizeMb}MB file: ${result.stderr}`);
  }
}

/** Load a Redis instance with ~targetMb of data via redis-benchmark. */
async function setupRedisWithData(sbx: Sandbox, targetMb: number) {
  const setup = await sbx.exec('which redis-server || apt-get update && apt-get install -y redis-server');
  if (setup.code !== 0) {
    throw new Error('redis-server is required in the sandbox image for FULL benchmarks');
  }
  await sbx.exec('redis-server --daemonize yes');
  const load = await sbx.exec(
    `redis-benchmark -t set -d ${Math.floor((targetMb * 1024 * 1024) / 1024)}b -n ${Math.max(1, Math.floor(targetMb))} --threads 2 2>&1 | tail -3`,
  );
  if (load.code !== 0) {
    throw new Error(`redis-benchmark failed: ${load.stderr}`);
  }
  const memory = await sbx.exec('redis-cli info memory | grep used_memory_human');
  console.log(`    → Redis memory usage: ${memory.stdout.trim()}`);
}

async function benchmarkBoot(snapshot: Snapshot, label: string): Promise<number[]> {
  const bootTimes: number[] = [];

  for (let boot = 1; boot <= BOOTS; boot++) {
    console.log(`    → Boot #${boot} from snapshot ${snapshot.name}...`);
    const start = Date.now();
    const sbx = await snapshot.spawn(undefined, { wait_ready: true, timeout: 300, api_token: apiToken });
    bootTimes.push((Date.now() - start) / 1000);
    await sbx.delete().catch(() => {});
  }

  const mean = bootTimes.reduce((a, b) => a + b, 0) / bootTimes.length;
  console.log(
    `    ✓ ${label}: mean ${mean.toFixed(1)}s, min ${Math.min(...bootTimes).toFixed(1)}s, max ${Math.max(...bootTimes).toFixed(1)}s`,
  );
  return bootTimes;
}

async function runBenchmark(kind: 'FILESYSTEM' | 'FULL', sizesMb: number[]) {
  console.log(`\n${'='.repeat(60)}\n ${kind} BENCHMARKS\n${'='.repeat(60)}`);
  const rows: string[] = [];

  for (const sizeMb of sizesMb) {
    console.log(`\n→ ${kind} ${sizeMb}MB`);
    let builder: Sandbox | undefined;
    let snapshot: Snapshot | undefined;

    try {
      builder = await Sandbox.create({
        name: `bench-${kind.toLowerCase()}-${sizeMb}mb-${suffix}`,
        image: 'koyeb/sandbox',
        instance_type: 'xlarge',
        wait_ready: true,
        timeout: 600,
        api_token: apiToken,
      });
      console.log(`  ✓ Builder created: ${builder.name}`);

      if (kind === 'FILESYSTEM') {
        await builder.exec('mkdir -p /data');
        await createFileOfSize(builder, '/data/snapshot_data.bin', sizeMb);
      } else {
        await setupRedisWithData(builder, sizeMb);
      }

      console.log(`  → Creating ${kind} snapshot...`);
      snapshot = await builder.snapshot(`bench-${kind.toLowerCase()}-${sizeMb}mb-${suffix}`, {
        snapshot_type: kind,
        wait_available: true,
        timeout: 1800,
      });
      console.log(`  ✓ Snapshot created: ${snapshot.name}`);

      const bootTimes = await benchmarkBoot(snapshot, `${kind} ${sizeMb}MB`);
      bootTimes.forEach((bootTime, i) =>
        rows.push(`${kind},${sizeMb}MB,${i + 1},${bootTime.toFixed(2)}`),
      );
    } finally {
      await snapshot?.delete().catch((error) => console.error(`  ! Failed to delete snapshot: ${error}`));
      await builder?.delete().catch((error) => console.error(`  ! Failed to delete builder: ${error}`));
    }
  }

  return rows;
}

async function main() {
  const rows: string[] = ['snapshot_type,snapshot_size,boot_number,boot_time_seconds'];

  if (!SKIP_FS) {
    rows.push(...(await runBenchmark('FILESYSTEM', FS_SIZES)));
  }
  if (!SKIP_FULL) {
    rows.push(...(await runBenchmark('FULL', FULL_SIZES)));
  }

  await writeFile(CSV, rows.join('\n') + '\n');
  console.log(`\n✓ Wrote ${rows.length - 1} boot timings to ${CSV}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
