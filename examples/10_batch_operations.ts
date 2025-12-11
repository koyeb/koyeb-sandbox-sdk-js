import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'batch-ops' });
const fs = sandbox.filesystem;

async function main() {
  const filesToCreate = [
    { path: '/tmp/file1.txt', content: 'Content of file 1' },
    { path: '/tmp/file2.txt', content: 'Content of file 2' },
    { path: '/tmp/file3.txt', content: 'Content of file 3' },
  ];

  await fs.write_files(filesToCreate);
  console.log('Created 3 files');

  const createdFiles = await fs.list_dir('/tmp');
  const batchFiles = createdFiles.filter((f) => f.startsWith('file'));
  console.log(`Files: ${batchFiles.join(', ')}`);

  const projectFiles = [
    { path: '/tmp/project/main.py', content: "print('Hello')" },
    { path: '/tmp/project/utils.py', content: 'def helper(): pass' },
    { path: '/tmp/project/README.md', content: '# My Project' },
  ];

  await fs.mkdir('/tmp/project', true);
  await fs.write_files(projectFiles);
  console.log('Created project structure');
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
