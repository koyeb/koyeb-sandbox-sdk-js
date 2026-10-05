import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'basic-commands', image: 'koyeb/sandbox' });
console.log(`Sandbox ID: ${sandbox.id}`);

async function main() {
  let result = await sandbox.exec("echo 'Sandbox is ready!'");
  console.log(result.stdout);

  result = await sandbox.exec("node -e 'console.log(2 + 2)'");
  console.log(result.stdout);

  result = await sandbox.exec(
    `node -e "
console.log('Node version: ' + process.version);
console.log('Platform: ' + process.platform);
"`,
  );
  console.log(result.stdout);
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
