import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'env-vars' });

async function main() {
  let result = await sandbox.exec('env | grep MY_VAR', { env: { MY_VAR: 'Hello', DEBUG: 'true' } });
  console.log(result.stdout);

  result = await sandbox.exec('python3 -c "import os; print(os.getenv(\'MY_VAR\'))"', {
    env: { MY_VAR: 'Hello from Python!' },
  });
  console.log(result.stdout);
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
