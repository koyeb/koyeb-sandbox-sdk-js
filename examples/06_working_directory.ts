import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'working-dir' });

async function main() {
  await sandbox.exec('mkdir -p /tmp/my_project/src');
  await sandbox.exec(`echo 'print("hello")' > /tmp/my_project/src/main.py`);

  let result = await sandbox.exec('pwd', { cwd: '/tmp/my_project' });
  console.log(result.stdout);

  result = await sandbox.exec('ls -la', { cwd: '/tmp/my_project' });
  console.log(result.stdout);

  result = await sandbox.exec('cat src/main.py', { cwd: '/tmp/my_project' });
  console.log(result.stdout);
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
