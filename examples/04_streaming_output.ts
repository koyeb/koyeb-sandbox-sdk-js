import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'streaming', image: 'koyeb/sandbox' });
console.log(`Sandbox ID: ${sandbox.id}`);

async function main() {
  const stream1 = sandbox.exec_stream(`node -e "
let i = 0;
const t = setInterval(() => {
  console.log('Line ' + ++i);
  if (i === 5) clearInterval(t);
}, 500);
"`);

  const code = await new Promise<number>((resolve) => {
    stream1.addEventListener('stdout', ({ data }) => process.stdout.write(`${data.data} `));
    stream1.addEventListener('stderr', ({ data }) => process.stdout.write(`ERR: ${data.data}`));
    stream1.addEventListener('exit', ({ data }) => resolve(data.code ?? 0));
  });

  console.log(`\nExit code: ${code}`);

  await sandbox.filesystem.write_file(
    '/tmp/counter.js',
    "#!/usr/bin/env node\nlet i = 0;\nconst t = setInterval(() => {\n  console.log('Count: ' + ++i);\n  if (i === 5) {\n    clearInterval(t);\n    console.log('Done!');\n  }\n}, 300);\n",
  );

  await sandbox.exec('chmod +x /tmp/counter.js');

  const stream2 = sandbox.exec_stream('/tmp/counter.js');

  await new Promise<void>((resolve) => {
    stream2.addEventListener('stdout', ({ data }) => console.log(data.data));
    stream2.addEventListener('exit', () => resolve());
  });
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
