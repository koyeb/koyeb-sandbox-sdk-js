import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExample, withSandbox } from './_helpers.js';

await runExample('upload and download', async () => {
  const directory = join(tmpdir(), `koyeb-example-${process.pid}`);
  const source = join(directory, 'source.txt');
  const destination = join(directory, 'destination.txt');
  await import('node:fs/promises').then((fs) => fs.mkdir(directory, { recursive: true }));

  try {
    await withSandbox('upload-download', {}, async (sandbox) => {
      const content = 'Upload and download test';
      await writeFile(source, content);
      await sandbox.filesystem.upload_file(source, '/tmp/uploaded.txt');
      assert.equal((await sandbox.filesystem.read_file('/tmp/uploaded.txt')).content, content);

      await sandbox.filesystem.download_file(destination, '/tmp/uploaded.txt');
      assert.equal(await readFile(destination, 'utf8'), content);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
