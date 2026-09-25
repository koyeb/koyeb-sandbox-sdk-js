/**
 * Docker-in-Docker: run containers inside a sandbox.
 *
 * The koyeb/sandbox:dind image ships the Docker daemon and CLI. The daemon
 * needs a privileged sandbox and nested builds are memory-hungry, so this
 * uses a medium instance. The image is built FROM scratch from a static
 * binary already in the sandbox image (runc), so nothing is pulled from a
 * registry — no external rate limits, no egress flakes.
 */
import { Sandbox } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);
const DOCKERD_TIMEOUT = 60;

async function waitForDocker(sbx: Sandbox, timeout = DOCKERD_TIMEOUT, interval = 2) {
  const deadline = Date.now() + timeout * 1_000;
  let last = 'no result';

  while (Date.now() < deadline) {
    const result = await sbx.exec('docker info');
    if (result.code === 0) {
      console.log('Docker daemon is ready');
      return;
    }
    last = `exit_code=${result.code}: ${result.stderr.trim().slice(0, 200)}`;
    await new Promise((resolve) => setTimeout(resolve, interval * 1_000));
  }

  throw new Error(`Docker daemon not ready within ${timeout}s, last: ${last}`);
}

async function main() {
  console.log('Creating privileged sandbox (image koyeb/sandbox:dind, instance_type=medium)...');
  const createStart = Date.now();
  const sandbox = await Sandbox.create({
    image: 'koyeb/sandbox:dind',
    name: `docker-in-docker-${suffix}`,
    wait_ready: true,
    instance_type: 'medium',
    privileged: true,
    api_token: apiToken,
  });
  console.log(`Created sandbox: ${sandbox.id} (took ${((Date.now() - createStart) / 1000).toFixed(1)}s)`);

  try {
    // The image entrypoint starts the Docker daemon; it can take a few more
    // seconds to accept connections after the sandbox is ready.
    await waitForDocker(sandbox);

    // Build an image entirely offline: FROM scratch, with runc as the entrypoint.
    console.log('Building image from scratch (no registry pull)...');
    const buildStart = Date.now();
    const build = await sandbox.exec(
      'mkdir -p /tmp/ctx && cd /tmp/ctx && ' +
        'cp $(command -v runc) ./app && ' +
        'printf \'FROM scratch\\nCOPY app /app\\nENTRYPOINT ["/app", "--version"]\\n\' > Dockerfile && ' +
        'docker build -q -t hello-offline .',
    );
    if (build.code !== 0) {
      throw new Error(`docker build failed (exit code ${build.code}):\n${build.stderr}`);
    }
    console.log(`Built image: ${build.stdout.trim()} (took ${((Date.now() - buildStart) / 1000).toFixed(1)}s)`);

    // --pull=never fails loudly if the image were missing, instead of
    // silently falling back to a registry pull.
    console.log('Running the container (docker run --pull=never)...');
    const run = await sandbox.exec('docker run --pull=never hello-offline');
    if (run.code !== 0) {
      throw new Error(`docker run failed (exit code ${run.code}):\n${run.stderr}`);
    }
    console.log(run.stdout);

    console.log('\n✓ Docker-in-Docker demo completed');
    return;
  } finally {
    await sandbox.delete().catch(() => {});
    console.log('Sandbox deleted');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
