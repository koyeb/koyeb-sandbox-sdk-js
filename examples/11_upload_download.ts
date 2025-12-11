import { Sandbox } from '@koyeb/sandbox-sdk';
import { execSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';

const sandbox = await Sandbox.create({ name: 'upload-download' });
const fs = sandbox.filesystem;

const local_file = execSync('mktemp -u --suffix _local.txt').toString().trim();
const downloaded_file = execSync('mktemp -u --suffix _downloaded.txt').toString().trim();

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
