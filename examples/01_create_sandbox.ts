import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'example-sandbox' });

export async function main() {
  const result = await sandbox.exec("echo 'Sandbox is ready!'");
  console.log(result.stdout);
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
