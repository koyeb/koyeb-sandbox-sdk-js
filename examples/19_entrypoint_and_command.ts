/**
 * Custom entrypoint and command overrides:
 * 1. a command with args (the image default entrypoint runs it),
 * 2. a custom entrypoint running node directly.
 */
import { Sandbox } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);

async function main() {
  // Example 1: custom command with args.
  console.log('=== Example 1: custom command ===');
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create({
      image: 'ubuntu',
      name: `custom-command-${suffix}`,
      command: '/bin/sh',
      args: ['-c', 'touch /tmp/command-was-here && sleep infinity'],
      api_token: apiToken,
      env: { LOG_LEVEL: 'DEBUG' },
    });

    const result = await sandbox.exec("cat /tmp/command-was-here && echo 'File exists'");
    console.log(`  ${result.stdout.trim()}`);
    if (result.code !== 0) {
      throw new Error('Expected /tmp/command-was-here to exist');
    }
    console.log('  OK: custom command created the file');
  } finally {
    await sandbox?.delete();
  }

  // Example 2: custom entrypoint with command — the entrypoint runs node,
  // proving the override was used.
  console.log('\n=== Example 2: custom entrypoint ===');
  try {
    sandbox = await Sandbox.create({
      image: 'node:22-slim',
      name: `custom-entrypoint-${suffix}`,
      entrypoint: ['node', '-e'],
      command:
        "require('fs').mkdirSync('/tmp'); require('fs').writeFileSync('/tmp/started-by-node', 'yes'); setInterval(() => {}, 1_000_000)",
      api_token: apiToken,
    });

    const result = await sandbox.exec('cat /tmp/started-by-node');
    const content = result.stdout.trim();
    console.log(`  Marker content: ${content}`);
    if (content !== 'yes') {
      throw new Error(`Expected 'yes', got '${content}'`);
    }
    console.log('  OK: node entrypoint created the marker file');
  } finally {
    await sandbox?.delete();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
