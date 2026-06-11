/**
 * Config files with secrets and interpolation.
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

  // Create sandbox with config files referencing the secret and using interpolation
  sandbox = await Sandbox.create({
    image: 'koyeb/sandbox',
    name: `config-files-${suffix}`,
    wait_ready: true,
    api_token: apiToken,
    env: {
      X: '2',
      // Secret as env var: rendered as "{{ secret.<name> }}"
      MY_SECRET: secret,
    },
    config_files: {
      // SecretRef value: server expands "{{ secret.<name> }}"
      '/tmp/secret_config.txt': { name: secretName },
      // Plain string with env interpolation; default permissions 0644
      '/tmp/interpolation.txt': '{{ X }}',
      // ConfigFile object with custom permissions
      '/tmp/restricted.txt': { content: 'only-owner-readable', permissions: '0600' },
    },
  });
  console.log(`Sandbox ID: ${sandbox.id}`);

  // Secret reference in config file
  let result = await sandbox.exec('cat /tmp/secret_config.txt');
  assert.equal(result.stdout.trim(), secretValue);
  console.log(`/tmp/secret_config.txt=${result.stdout.trim()}`);

  // Env var interpolation in config file
  result = await sandbox.exec('cat /tmp/interpolation.txt');
  assert.equal(result.stdout.trim(), '2');
  console.log(`/tmp/interpolation.txt=${result.stdout.trim()}`);

  // Custom permissions
  result = await sandbox.exec("stat -c '%a' /tmp/restricted.txt");
  assert.equal(result.stdout.trim(), '600');
  console.log(`/tmp/restricted.txt permissions=${result.stdout.trim()}`);

  // Secret env var was resolved
  result = await sandbox.exec('printenv MY_SECRET');
  assert.equal(result.stdout.trim(), secretValue);
  console.log(`MY_SECRET=${result.stdout.trim()}`);
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
