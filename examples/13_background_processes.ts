import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'background-processes' });

async function main() {
  console.log('Launching background processes...');

  const processId1 = await sandbox.launch_process(
    'python3 -c \'import time; [print(f"Process 1: {i}") or time.sleep(1) for i in range(10)]\'',
  );
  console.log(`Launched process 1: ${processId1}`);

  const processId2 = await sandbox.launch_process(
    'python3 -c \'import time; [print(f"Process 2: {i}") or time.sleep(1) for i in range(5)]\'',
  );
  console.log(`Launched process 2: ${processId2}`);

  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log('\nListing all processes:');
  const processes = await sandbox.list_processes();
  for (const process of processes) {
    console.log(`  ID: ${process.id}`);
    console.log(`  Command: ${process.command}`);
    console.log(`  Status: ${process.status}`);
    if (process.pid) {
      console.log(`  PID: ${process.pid}`);
    }
    console.log();
  }

  console.log(`Killing process ${processId2}...`);
  await sandbox.kill_process(processId2);
  console.log('Process killed');

  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log('\nListing processes after kill:');
  const processesAfterKill = await sandbox.list_processes();
  for (const process of processesAfterKill) {
    console.log(`  ID: ${process.id}`);
    console.log(`  Command: ${process.command}`);
    console.log(`  Status: ${process.status}`);
    console.log();
  }

  const processId3 = await sandbox.launch_process('sleep 5');
  const processId4 = await sandbox.launch_process('sleep 5');
  console.log(`Launched processes 3 and 4: ${processId3}, ${processId4}`);

  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log('\nKilling all running processes...');
  const killedCount = await sandbox.kill_all_processes();
  console.log(`Killed ${killedCount} processes`);

  console.log('\nFinal process list:');
  const finalProcesses = await sandbox.list_processes();
  for (const process of finalProcesses) {
    console.log(`  ID: ${process.id}`);
    console.log(`  Command: ${process.command}`);
    console.log(`  Status: ${process.status}`);
    console.log();
  }
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
