import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'directory-ops' });
const fs = sandbox.filesystem;

async function main() {
  await fs.mkdir('/tmp/my_project');
  await fs.mkdir('/tmp/my_project/src/utils', true);

  const contents = await fs.list_dir('/tmp/my_project');
  console.log(`Contents: ${contents.join(', ')}`);

  await fs.mkdir('/tmp/my_project/src', true);
  await fs.mkdir('/tmp/my_project/tests', true);
  await fs.write_file('/tmp/my_project/src/main.py', "print('Hello')");
  await fs.write_file('/tmp/my_project/README.md', '# My Project');

  const exists = await fs.exists('/tmp/my_project');
  const isDir = await fs.is_dir('/tmp/my_project');
  const isFile = await fs.is_file('/tmp/my_project/src/main.py');
  console.log(`Exists: ${exists}, Is dir: ${isDir}, Is file: ${isFile}`);
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
