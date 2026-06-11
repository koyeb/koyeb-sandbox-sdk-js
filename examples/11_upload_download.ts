import { Sandbox } from '@koyeb/sandbox-sdk';
import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = await Sandbox.create({ name: 'upload-download' });
console.log(`Sandbox ID: ${sandbox.id}`);
const fs = sandbox.filesystem;

const tmpName = (suffix: string) => join(tmpdir(), `tmp-${randomBytes(6).toString('hex')}${suffix}`);
const local_file = tmpName('_local.txt');
const downloaded_file = tmpName('_downloaded.txt');

async function main() {
  await writeFile(local_file, 'This is a local file\nUploaded to Koyeb Sandbox!');
  await fs.upload_file(local_file, '/tmp/uploaded_file.txt');

  const uploaded_info = await fs.read_file('/tmp/uploaded_file.txt');
  console.log(uploaded_info.content);

  await fs.write_file('/tmp/download_source.txt', 'Download test content\nMultiple lines');
  await fs.download_file(downloaded_file, '/tmp/download_source.txt');
  console.log((await readFile(downloaded_file)).toString());
}

async function cleanup() {
  await Promise.allSettled([unlink(local_file), unlink(downloaded_file), sandbox.delete()]);
}

main().catch(console.error).finally(cleanup);
