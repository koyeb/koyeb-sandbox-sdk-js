import assert from 'node:assert/strict';

import { type Sandbox } from '@koyeb/sandbox-sdk';

import { assertCommand, runExample, sleep, withSandbox } from './_helpers.js';

const dockerTimeoutSeconds = 60;

async function waitForDocker(sandbox: Sandbox): Promise<void> {
  const attempts = dockerTimeoutSeconds / 2;
  let lastResult = await sandbox.exec('docker info');

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (lastResult.code === 0) return;
    if (attempt < attempts) {
      await sleep(2);
      lastResult = await sandbox.exec('docker info');
    }
  }

  assert.fail(`Docker daemon was not ready within ${dockerTimeoutSeconds} seconds: ${lastResult.stderr.slice(0, 200)}`);
}

await runExample('Docker-in-Docker', async () => {
  await withSandbox(
    'docker-in-docker',
    { image: 'koyeb/sandbox:dind', instance_type: 'medium', privileged: true },
    async (sandbox) => {
      await waitForDocker(sandbox);

      const build = await sandbox.exec(
        [
          'mkdir -p /tmp/ctx',
          'cd /tmp/ctx',
          'cp "$(command -v runc)" ./app',
          'printf \'FROM scratch\\nCOPY app /app\\nENTRYPOINT ["/app", "--version"]\\n\' > Dockerfile',
          'docker build -q -t hello-offline .',
        ].join(' && '),
        { timeout: 300 },
      );
      assertCommand(build, 'docker build');
      assert.ok(build.stdout.trim(), 'Docker build returned no image id');

      const result = await sandbox.exec('docker run --pull=never hello-offline', { timeout: 300 });
      assertCommand(result, 'docker run');
      assert.match(result.stdout, /runc version/);
    },
  );
});
