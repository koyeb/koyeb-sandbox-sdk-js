import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'streaming' });

async function main() {
  const stream1 = sandbox.exec_stream(`python3 -c "
import time
for i in range(5):
    print(f'Line {i+1}')
    time.sleep(0.5)
"`);

  const code = await new Promise<number>((resolve) => {
    stream1.addEventListener('stdout', ({ data }) => process.stdout.write(`${data.data} `));
    stream1.addEventListener('stderr', ({ data }) => process.stdout.write(`ERR: ${data.data}`));
    stream1.addEventListener('exit', ({ data }) => resolve(data.code));
  });

  console.log(`\nExit code: ${code}`);

  await sandbox.filesystem.write_file(
    '/tmp/counter.py',
    "#!/usr/bin/env python3\nimport time\nfor i in range(1, 6):\n    print(f'Count: {i}')\n    time.sleep(0.3)\nprint('Done!')\n",
  );

  await sandbox.exec('chmod +x /tmp/counter.py');

  const stream2 = sandbox.exec_stream('/tmp/counter.py');

  await new Promise<void>((resolve) => {
    stream2.addEventListener('stdout', ({ data }) => console.log(data.data));
    stream2.addEventListener('exit', () => resolve());
  });
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
