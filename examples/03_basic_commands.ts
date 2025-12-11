import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'basic-commands' });

async function main() {
  let result = await sandbox.exec("echo 'Sandbox is ready!'");
  console.log(result.stdout);

  result = await sandbox.exec("python3 -c 'print(2 + 2)'");
  console.log(result.stdout);

  result = await sandbox.exec(
    `python3 -c "
import sys
print(f'Python version: {sys.version.split()[0]}')
print(f'Platform: {sys.platform}')
"`,
  );
  console.log(result.stdout);
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
