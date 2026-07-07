/**
 * Egress network policy: block all outbound traffic or restrict it to an allowlist.
 */
import { EgressPolicyError, Sandbox } from '@koyeb/sandbox-sdk';
import { strict as assert } from 'node:assert';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

// Outbound probe run inside the sandbox; fails when egress is blocked.
const PROBE = 'python3 -c "import urllib.request; urllib.request.urlopen(\'https://example.com\', timeout=5)"';

const suffix = Math.random().toString(36).slice(2, 10);

let sandbox: Sandbox | undefined;

async function main() {
  // block_network and outbound_allowlist are mutually exclusive; passing both is
  // rejected client-side, before any API call.
  try {
    await Sandbox.create({
      name: `egress-${suffix}`,
      api_token: apiToken,
      block_network: true,
      outbound_allowlist: ['1.1.1.1'],
    });
    throw new Error('Expected EgressPolicyError');
  } catch (error) {
    assert(error instanceof EgressPolicyError, 'Expected EgressPolicyError');
    console.log(`Conflicting arguments rejected: ${error.message}`);
  }

  // Create a sandbox with all outbound network access blocked.
  sandbox = await Sandbox.create({
    image: 'koyeb/sandbox',
    name: `egress-${suffix}`,
    wait_ready: true,
    api_token: apiToken,
    block_network: true,
  });
  console.log(`Sandbox ID: ${sandbox.id}`);
  console.log(`Created sandbox with block_network=true: ${sandbox.name}`);

  // Outbound requests from inside the sandbox fail.
  const blocked = await sandbox.exec(PROBE);
  assert.notEqual(blocked.code, 0, 'Expected outbound request to fail');
  console.log(`Outbound request blocked (exit code ${blocked.code})`);

  // Switch to an allowlist: only the listed destinations are reachable. Entries are
  // CIDRs or bare IPs (normalized to /32 for IPv4, /128 for IPv6). This triggers a
  // redeployment of the sandbox service.
  await sandbox.update_network_policy({ outbound_allowlist: ['1.1.1.1', '9.9.0.0/16'] });
  console.log('Egress policy updated to allowlist: 1.1.1.1/32, 9.9.0.0/16');

  // Reset to the platform default (unrestricted outbound access).
  await sandbox.update_network_policy();
  console.log('Egress policy reset to default');
}

async function cleanup() {
  if (sandbox) {
    await sandbox.delete().catch(console.error);
  }
}

main().catch(console.error).finally(cleanup);
