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

const suffix = Math.random().toString(36).slice(2, 10);

// Outbound probe run inside the sandbox; fails when egress is blocked.
// The sandbox image ships Node LTS, so the probe speaks JS.
const probe = (url: string) =>
  `node -e "fetch('${url}', { signal: AbortSignal.timeout(5000) }).then(() => process.exit(0)).catch(() => process.exit(1))"`;

const PROBE = probe('https://example.com');
// The allowlist probe must hit an allowed destination; example.com is not in it.
const PROBE_ALLOWED = probe('https://1.1.1.1');

let sandbox: Sandbox | undefined;

/**
 * Run a probe repeatedly until it reaches the expected allowed/blocked state.
 *
 * A network-policy change redeploys the sandbox. Even after wait_ready()
 * reports the new deployment healthy, the data plane needs a few more seconds
 * to enforce the new egress rules, and the instance can briefly return errors
 * or drop connections while routing to the replacement settles.
 */
async function waitForProbe(probe: string, expectAllowed: boolean, label: string, timeout = 120, interval = 3) {
  const deadline = Date.now() + timeout * 1_000;

  for (;;) {
    let result: { code: number };

    try {
      result = await sandbox!.exec(probe);
    } catch (error) {
      // Instance momentarily unreachable during the rollout; retry.
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, interval * 1_000));
      continue;
    }

    if ((result.code === 0) === expectAllowed) {
      console.log(`${label}: ${expectAllowed ? 'allowed' : 'blocked'} (exit code ${result.code})`);
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`${label}: expected ${expectAllowed ? 'allowed' : 'blocked'}, got exit code ${result.code}`);
    }

    await new Promise((resolve) => setTimeout(resolve, interval * 1_000));
  }
}

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

  // The update redeploys the sandbox; wait for the replacement before probing it.
  await sandbox.wait_ready();

  // 1.1.1.1 is in the allowlist → succeeds once the new egress rules propagate.
  await waitForProbe(PROBE_ALLOWED, true, 'allowlist=[1.1.1.1, ...] → 1.1.1.1');
  // example.com is NOT in the allowlist → still blocked.
  await waitForProbe(PROBE, false, 'allowlist=[1.1.1.1, ...] → example.com');

  // Reset to the platform default (unrestricted outbound access).
  await sandbox.update_network_policy();
  console.log('Egress policy reset to default');

  // The reset redeploys the sandbox; wait for the replacement before probing it.
  await sandbox.wait_ready();

  // Default mode → public internet reachable again.
  await waitForProbe(PROBE, true, 'default → example.com');
}

async function cleanup() {
  if (sandbox) {
    await sandbox.delete().catch(console.error);
  }
}

main().catch(console.error).finally(cleanup);
