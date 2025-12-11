import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'file-ops' });
const fs = sandbox.filesystem;

async function main() {
  const content = 'Hello, Koyeb Sandbox!\nThis is a test file.';
  await fs.write_file('/tmp/hello.txt', content);

  const fileInfo = await fs.read_file('/tmp/hello.txt');
  console.log(fileInfo.content);

  const code = "#!/usr/bin/env python3\nprint('Hello from Python!')\n";
  await fs.write_file('/tmp/script.py', code);
  await sandbox.exec('chmod +x /tmp/script.py');
  const result = await sandbox.exec('/tmp/script.py');
  console.log(result.stdout);
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
