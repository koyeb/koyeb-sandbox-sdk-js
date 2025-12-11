import { Sandbox } from '@koyeb/sandbox-sdk';

class Timer {
  private operations = new Array<{ name: string; duration: number }>();

  async time<T>(operation: string, label: string, fn: () => Promise<T>): Promise<T> {
    console.log(`  → ${label}...`);

    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;

    console.log(`    ✓ took ${(duration / 1000).toFixed(2)}s`);
    this.operations.push({ name: operation, duration });

    return result;
  }

  summary() {
    const line = (label: string, duration: number, bar = true) => {
      const percentage = duration / total;

      const values = [
        label.padEnd(30),
        `${(duration / 1000).toFixed(2).padStart(6)}s`,
        `${(percentage * 100).toFixed(1).padStart(5)}%`,
        bar && '█'.repeat(Math.floor(percentage * 22)),
      ].filter(Boolean);

      return values.join(' ');
    };

    const total = this.operations.reduce((acc, op) => acc + op.duration, 0);

    return [
      ['='.repeat(70), ' TIMING SUMMARY', '='.repeat(70)].join('\n'),
      ...this.operations.map(({ name, duration }) => `  ${line(name, duration)}`),
      ['-'.repeat(70), `  ${line('TOTAL', total, false)}`, '='.repeat(70)].join('\n'),
    ].join('\n');
  }
}

const timer = new Timer();

console.log('Starting sandbox operations...');

const sandbox = await timer.time('Sandbox creation', 'Creating sandbox', () =>
  Sandbox.create({ name: 'example-sandbox-timed' }),
);

async function main(args: { long?: boolean }) {
  await timer.time('Health check', 'Checking sandbox health', () => sandbox.is_healthy());

  await timer.time('Initial exec command', 'Executing initial test command', () =>
    sandbox.exec('echo "Sandbox is ready!"'),
  );

  if (args.long) {
    await timer.time('Package installation', '[LONG TEST] Installing a package', () =>
      sandbox.exec('pip install requests'),
    );

    await timer.time('Heavy computation', '[LONG TEST] Running computation', () =>
      sandbox.exec("python -c 'import time; sum(range(10000000)); time.sleep(2)'"),
    );

    await timer.time('Multiple health checks (5x)', '[LONG TEST] Multiple health checks...', async () => {
      for (let i = 0; i < 5; i++) {
        await sandbox.is_healthy();
      }
    });
  }
}

console.log('\n✓ All operations completed\n');
console.log(timer.summary());

async function cleanup() {
  await timer.time('Sandbox deletion', 'Deleting sandbox', () => sandbox.delete());
}

main({ long: process.argv.includes('--long') })
  .catch(console.error)
  .finally(cleanup);
