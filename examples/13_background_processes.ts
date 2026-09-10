import assert from 'node:assert/strict';

import { runExample, sleep, withSandbox } from './_helpers.js';

await runExample('background processes', async () => {
  await withSandbox('background-processes', {}, async (sandbox) => {
    const first = await sandbox.launch_process('sleep 30');
    const second = await sandbox.launch_process('sleep 30');
    await sleep(1);

    const running = await sandbox.list_processes();
    assert.ok(running.some((process) => process.id === first));
    assert.ok(running.some((process) => process.id === second));

    await sandbox.kill_process(second);
    const killed = await sandbox.kill_all_processes();
    assert.ok(killed >= 1);
  });
});
