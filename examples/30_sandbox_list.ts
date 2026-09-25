/**
 * List sandboxes with Sandbox.list() and connect a lazy handle.
 *
 * list() returns lazy handles: they know id/name but carry no executor
 * secret, so connected operations raise NoSandboxSecretError — connect
 * with Sandbox.get_from_id(handle.id) when you need to run commands.
 */
import { NoSandboxSecretError, Sandbox } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('KOYEB_API_TOKEN is not set');
  process.exit(1);
}

async function main() {
  // Create one sandbox so the listing has something of ours to find.
  const ours = await Sandbox.create({ name: 'list-demo', api_token: apiToken });
  console.log(`✓ Created ${ours.id}`);

  try {
    const handles = await Sandbox.list({ api_token: apiToken });
    console.log(`✓ Listed ${handles.length} sandbox service(s)`);
    for (const handle of handles.slice(0, 5)) {
      console.log(`  ${handle.id}  ${handle.name}`);
    }

    // Lazy handles have no executor secret...
    const oursHandle = handles.find((handle) => handle.id === ours.id)!;
    await oursHandle.exec('echo hi').then(
      () => {
        throw new Error('Expected the lazy handle to raise');
      },
      (error: unknown) => {
        if (!(error instanceof NoSandboxSecretError)) {
          throw error;
        }
        console.log('✓ Lazy handle has no secret, as documented');
      },
    );

    // ...so connect through get_from_id before running commands.
    const connected = await Sandbox.get_from_id(ours.id, apiToken);
    const out = await connected.exec('echo hello from the list demo');
    console.log(`✓ Connected handle output: ${out.stdout.trim()}`);
  } finally {
    await ours.delete();
    console.log('✓ Cleaned up');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
