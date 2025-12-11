import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'file-manip' });
const fs = sandbox.filesystem;

async function main() {
  await fs.write_file('/tmp/file1.txt', 'Content of file 1');
  await fs.write_file('/tmp/file2.txt', 'Content of file 2');
  await fs.mkdir('/tmp/test_dir');

  await fs.rename_file('/tmp/file1.txt', '/tmp/renamed_file.txt');
  console.log(`Renamed: ${await fs.exists('/tmp/renamed_file.txt')}`);

  await fs.rename_file('/tmp/file2.txt', '/tmp/test_dir/moved_file.txt');
  console.log(`Moved: ${await fs.exists('/tmp/test_dir/moved_file.txt')}`);

  const original_content = await fs.read_file('/tmp/renamed_file.txt');
  await fs.write_file('/tmp/test_dir/copied_file.txt', original_content.content);
  console.log(`Copied: ${await fs.exists('/tmp/test_dir/copied_file.txt')}`);

  await fs.rm('/tmp/renamed_file.txt');
  console.log(`Deleted: ${!(await fs.exists('/tmp/renamed_file.txt'))}`);

  await fs.rm('/tmp/test_dir', true);
  console.log(`Directory deleted: ${!(await fs.exists('/tmp/test_dir'))}`);
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
