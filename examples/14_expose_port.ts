import { Sandbox } from '@koyeb/sandbox-sdk';

const sandbox = await Sandbox.create({ name: 'expose-port' });

async function main() {
  console.log('\nCreating test file...');
  await sandbox.filesystem.write_file('/tmp/test.html', '<h1>Hello from Sandbox!</h1><p>Port 8080</p>');
  console.log('Test file created');

  console.log('\nStarting HTTP server on port 8080...');
  const process_id = await sandbox.launch_process('python3 -m http.server 8080', { cwd: '/tmp' });
  console.log(`Server started with process ID: ${process_id}`);

  console.log('Waiting for server to start...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log('\nExposing port 8080...');
  let exposed = await sandbox.expose_port(8080);
  console.log(`Port exposed: ${exposed.port}`);
  console.log(`Exposed at: ${exposed.exposed_at}`);

  console.log('Waiting for port to be ready...');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log('\nMaking HTTP request to verify port exposure...');
  let res = await fetch(`${exposed.exposed_at}/test.html`);

  if (!res.ok) {
    throw new Error(`Status: ${res.status}`);
  }

  console.log(`✓ Request successful! Status: ${res.status}`);
  console.log(`✓ Response content: ${await res.text()}`);

  console.log('\nRunning processes:');
  const processes = await sandbox.list_processes();

  for (const process of processes) {
    if (process.status === 'running') {
      console.log(`  ${process.id}: ${process.command} - ${process.status}`);
    }
  }

  console.log('\nSwitching to port 8081...');
  await sandbox.filesystem.write_file('/tmp/test2.html', '<h1>Hello from Sandbox!</h1><p>Port 8081</p>');
  await sandbox.launch_process('python3 -m http.server 8081', { cwd: '/tmp' });

  console.log('Waiting for server to start...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  exposed = await sandbox.expose_port(8081);
  console.log(`Port exposed: ${exposed.port}`);
  console.log(`Exposed at: ${exposed.exposed_at}`);

  console.log('Waiting for port to be ready...');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log('\nMaking HTTP request to verify port 8081...');
  res = await fetch(`${exposed.exposed_at}/test2.html`);

  if (!res.ok) {
    throw new Error(`Status: ${res.status}`);
  }

  console.log(`✓ Request successful! Status: ${res.status}`);
  console.log(`✓ Response content: ${await res.text()}`);

  console.log('\nUnexposing port...');
  await sandbox.unexpose_port();
  console.log('Port unexposed');
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
