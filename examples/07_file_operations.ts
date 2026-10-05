import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'file-ops', image: 'koyeb/sandbox' });
console.log(`Sandbox ID: ${sandbox.id}`);
const fs = sandbox.filesystem;

async function main() {
  const content = 'Hello, Koyeb Sandbox!\nThis is a test file.';
  await fs.write_file('/tmp/hello.txt', content);

  const fileInfo = await fs.read_file('/tmp/hello.txt');
  console.log(fileInfo.content);

  const code = "#!/usr/bin/env node\nconsole.log('Hello from Node!')\n";
  await fs.write_file('/tmp/script.js', code);
  await sandbox.exec('chmod +x /tmp/script.js');
  const result = await sandbox.exec('/tmp/script.js');
  console.log(result.stdout);
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
