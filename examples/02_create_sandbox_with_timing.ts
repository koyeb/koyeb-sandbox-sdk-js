import assert from 'node:assert/strict';

import { Sandbox } from '@koyeb/sandbox-sdk';

import { assertCommand, runExample, sandboxOptions } from './_helpers.js';

await runExample('create sandbox with timing', async () => {
  const timings = new Map<string, number>();
  const time = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    const result = await operation();
    timings.set(name, performance.now() - startedAt);
    return result;
  };

  const sandbox = await time('create', () => Sandbox.create(sandboxOptions('timed-sandbox')));
  try {
    assert.equal(await time('health', () => sandbox.is_healthy()), true);
    const result = await time('exec', () => sandbox.exec('echo ready'));
    assertCommand(result);
    assert.equal(result.stdout.trim(), 'ready');
    assert.ok([...timings.values()].every((duration) => duration >= 0));
    console.table(
      Object.fromEntries([...timings].map(([name, duration]) => [name, `${(duration / 1000).toFixed(2)}s`])),
    );
  } finally {
    await time('delete', () => sandbox.delete());
  }
});
