/**
 * Opt-in exec errors: raise_on_error turns a failed command into an exception.
 *
 * By default a failed command returns a result with its exit code; with
 * raise_on_error: true it raises SandboxCommandError carrying that result.
 */
import { Sandbox, SandboxCommandError } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('KOYEB_API_TOKEN is not set');
  process.exit(1);
}

async function main() {
  const sandbox = await Sandbox.create({ name: 'raise-demo', api_token: apiToken });
  console.log(`✓ Created ${sandbox.id}`);

  try {
    // Default: a failed command is a value, not an exception.
    const result = await sandbox.exec('ls /definitely-missing');
    console.log(`✓ Default returned code=${result.code} (non-zero, not raised)`);

    // Opt-in: the same command raises, with the result attached.
    await sandbox.exec('ls /definitely-missing', { raise_on_error: true }).then(
      () => {
        throw new Error('Expected SandboxCommandError');
      },
      (error: unknown) => {
        if (!(error instanceof SandboxCommandError)) {
          throw error;
        }
        console.log(`✓ Raised SandboxCommandError: exit=${error.exit_code}`);
        console.log(`  stderr: ${error.result.stderr.trim()}`);
      },
    );
  } finally {
    await sandbox.delete();
    console.log('✓ Cleaned up');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
