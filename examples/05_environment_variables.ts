/**
 * Environment variables with secrets and interpolation.
 */
import { KoyebApi, Sandbox } from '@koyeb/sandbox-sdk';
import { strict as assert } from 'node:assert';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);
const secretName = `test-secret-${suffix}`;
const secretValue = 'secret-value-123';

const api = new KoyebApi(apiToken);

let sandbox: Sandbox | undefined;
let secretId: string | undefined;

async function main() {
  // Create a Koyeb secret
  const secret = await api.createSecret({ name: secretName, value: secretValue });
  secretId = secret.id;
  console.log(`Created secret: ${secretName}`);

  // Create sandbox with env vars referencing the secret and using interpolation
  sandbox = await Sandbox.create({
    image: 'koyeb/sandbox',
    name: `env-vars-${suffix}`,
    wait_ready: true,
    api_token: apiToken,
    env: {
      // Pass the Secret directly — rendered as "{{ secret.<name> }}"
      SECRET_VAL: secret,
      X: '2',
      // Plain string with server-side interpolation
      Y: '{{ X }}',
    },
  });

  let result = await sandbox.exec('echo "$SECRET_VAL"');
  assert.equal(result.stdout.trim(), secretValue);
  console.log(`SECRET_VAL=${result.stdout.trim()}`);

  result = await sandbox.exec('echo "$X"');
  assert.equal(result.stdout.trim(), '2');
  console.log(`X=${result.stdout.trim()}`);

  result = await sandbox.exec('echo "$Y"');
  assert.equal(result.stdout.trim(), '2');
  console.log(`Y=${result.stdout.trim()}`);
}

async function cleanup() {
  if (sandbox) {
    await sandbox.delete().catch(console.error);
  }
  if (secretId) {
    await api.deleteSecret(secretId).catch(console.error);
  }
}

main().catch(console.error).finally(cleanup);
