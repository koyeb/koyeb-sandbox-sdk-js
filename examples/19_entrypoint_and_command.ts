import assert from 'node:assert/strict';

import { assertCommand, runExample, withSandbox } from './_helpers.js';

await runExample('entrypoint and command', async () => {
  await withSandbox(
    'custom-command',
    {
      image: 'ubuntu',
      command: '/bin/sh',
      args: ['-c', 'touch /tmp/command-was-here && sleep infinity'],
    },
    async (sandbox) => {
      const result = await sandbox.exec('test -f /tmp/command-was-here');
      assertCommand(result);
    },
  );

  await withSandbox(
    'custom-entrypoint',
    {
      image: 'python:3.12-slim',
      entrypoint: ['python3', '-c'],
      command: "open('/tmp/started-by-python', 'w').write('yes'); import time; time.sleep(999999)",
    },
    async (sandbox) => {
      const result = await sandbox.exec('cat /tmp/started-by-python');
      assertCommand(result);
      assert.equal(result.stdout.trim(), 'yes');
    },
  );
});
