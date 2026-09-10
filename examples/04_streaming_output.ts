import assert from 'node:assert/strict';

import type { SandboxExec } from '@koyeb/sandbox-sdk';

import { runExample, withSandbox } from './_helpers.js';

async function collect(stream: SandboxExec): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let code = -1;
    stream.addEventListener('stdout', ({ data }) => (stdout += data.data));
    stream.addEventListener('stderr', ({ data }) => (stderr += data.data));
    stream.addEventListener('exit', ({ data }) => (code = data.code));
    stream.addEventListener('error', ({ data }) => reject(data));
    stream.addEventListener('end', () => resolve({ stdout, stderr, code }));
  });
}

await runExample('streaming output', async () => {
  await withSandbox('streaming-output', {}, async (sandbox) => {
    const success = await collect(sandbox.exec_stream("printf 'one\\ntwo\\n'"));
    assert.equal(success.code, 0);
    assert.match(success.stdout, /one/);
    assert.match(success.stdout, /two/);

    const failure = await collect(sandbox.exec_stream("sh -c 'echo failed >&2; exit 7'"));
    assert.equal(failure.code, 7);
    assert.match(failure.stderr, /failed/);
  });
});
