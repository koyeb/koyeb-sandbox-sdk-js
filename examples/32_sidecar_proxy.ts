/**
 * Sidecar proxy: inject a credential without the sandbox holding it.
 *
 * A mitmproxy sidecar runs next to the sandbox, on a private mesh. The sandbox
 * sends its HTTPS traffic through the proxy (HTTPS_PROXY=http://proxy:8080).
 * The proxy adds an Authorization header for one destination only, from a
 * token that lives in the sidecar's environment: code in the sandbox never
 * sees it.
 *
 * The proxy decides on the real destination (host, port, HTTPS), never on the
 * Host header, which the sandbox controls. https://httpbin.org/bearer accepts
 * any bearer token and replies only whether one was sent, so the token doesn't
 * come back to the sandbox. Real upstreams can echo headers: inject only into
 * destinations you trust.
 *
 * The sandbox fetches the proxy's public CA certificate through the proxy
 * (mitmproxy serves it at http://mitm.it) and trusts it; the CA's private key
 * stays in the sidecar.
 *
 * The sandbox keeps normal egress: the proxy is opt-in for code in the sandbox.
 */
import { Sandbox, Sidecar } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const INJECT_HOST = 'httpbin.org';

// mitmproxy addon, mounted in the sidecar. Injects the token for one
// destination only: a proxy that adds credentials to every request would
// hand them to any host the sandbox chooses. It checks the connection's real
// destination, not pretty_host, which comes from the client's Host header,
// and rejects requests whose Host header disagrees with it.
const ADDON = `import os

TOKEN = os.environ["DEMO_TOKEN"]

def request(flow):
    req = flow.request
    if (
        req.scheme == "https"
        and req.host == "${INJECT_HOST}"
        and req.port == 443
        and req.host_header in (None, "${INJECT_HOST}")
    ):
        req.headers["Authorization"] = f"Bearer {TOKEN}"
    else:
        req.headers.pop("Authorization", None)
`;

const PROXY = 'http://proxy:8080';
const TRUST_PROXY_CA =
  `curl -sf -x ${PROXY} http://mitm.it/cert/pem ` +
  '-o /usr/local/share/ca-certificates/sidecar-proxy.crt ' +
  '&& update-ca-certificates >/dev/null';
// 200 only if the proxy injected a bearer token; the token isn't echoed.
const REQUEST = `curl -s -m 20 -o /dev/null -w '%{http_code}' https://${INJECT_HOST}/bearer`;
// Spoofing the Host header must not get a token. httpbin.org/headers echoes
// what it received, so the check can see whether a token was added: once over
// plain HTTP with a forged Host, once over HTTPS with a mismatched Host.
const SPOOFED =
  `curl -s -m 20 -H 'Host: ${INJECT_HOST}' http://${INJECT_HOST}/headers; ` +
  `curl -s -m 20 -H 'Host: attacker.example' https://${INJECT_HOST}/headers`;

const random = (alphabet: string, length: number) =>
  Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

// In production, pass env: { DEMO_TOKEN: { name: 'my-api-key' } } so the
// platform injects a stored secret at deploy time.
const token = `demo-${random('abcdefghijklmnopqrstuvwxyz', 12)}`;
const suffix = random('abcdefghijklmnopqrstuvwxyz0123456789', 6);

const proxy = new Sidecar({
  name: 'proxy',
  image: 'mitmproxy/mitmproxy:latest',
  ports: [8080],
  command: 'mitmdump',
  args: ['--listen-port', '8080', '-s', '/etc/sidecar/inject.py'],
  config_files: { '/etc/sidecar/inject.py': ADDON },
  env: { DEMO_TOKEN: token },
});

let sandbox: Sandbox | undefined;

async function main() {
  console.log('Creating a sandbox with a proxy sidecar...');
  sandbox = await Sandbox.create({
    image: 'koyeb/sandbox',
    name: `sidecar-proxy-${suffix}`,
    wait_ready: true,
    api_token: apiToken,
    env: { HTTPS_PROXY: PROXY, NO_PROXY: 'localhost,127.0.0.1' },
    sidecars: [proxy],
    timeout: 600,
  });
  console.log(`Sidecar reachable from the sandbox at ${sandbox.sidecar('proxy').url()}`);

  const trusted = await sandbox.exec(TRUST_PROXY_CA);
  if (trusted.code !== 0) {
    throw new Error(`Could not trust the proxy CA: ${trusted.stderr}`);
  }
  console.log("Sandbox trusts the proxy's CA");

  // 200 only if the proxy injected the bearer token.
  const request = await sandbox.exec(REQUEST);
  const status = request.stdout.trim();
  if (status !== '200') {
    throw new Error(`The proxy did not inject the token (HTTP ${status})`);
  }
  console.log(`${INJECT_HOST} accepted the token the proxy injected`);

  const spoofed = await sandbox.exec(SPOOFED);
  if (spoofed.stdout.includes(token) || spoofed.stdout.includes('Bearer')) {
    throw new Error('The proxy injected the token for a spoofed Host header');
  }
  console.log('No token for a spoofed Host header');

  const env = await sandbox.exec(`env | grep -c ${token} || true`);
  if (env.stdout.trim() !== '0') {
    throw new Error('The token is visible in the sandbox');
  }
  console.log("The token is not in the sandbox's environment");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (sandbox) {
      await sandbox.delete().catch(console.error);
      console.log('Deleted the sandbox and its sidecar');
    }
  });
