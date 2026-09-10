import assert from 'node:assert/strict';

import { retry, runExample, sleep, withSandbox } from './_helpers.js';

await runExample('expose port', async () => {
  await withSandbox('expose-port', {}, async (sandbox) => {
    await sandbox.filesystem.write_file('/tmp/index.html', '<h1>Hello from Sandbox</h1>');
    const processId = await sandbox.launch_process('python3 -m http.server 8080', { cwd: '/tmp' });
    assert.ok(processId);
    await sleep(2);

    const exposed = await sandbox.expose_port(8080);
    assert.equal(exposed.port, 8080);
    const response = await retry(async () => {
      const result = await fetch(`${exposed.exposed_at}/index.html`);
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      return result;
    });
    assert.match(await response.text(), /Hello from Sandbox/);
    await sandbox.unexpose_port(8080);
  });
});
