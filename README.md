# Koyeb Sandbox SDK for JavaScript/TypeScript

[![License](https://img.shields.io/npm/l/@koyeb/sandbox-sdk)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@koyeb/sandbox-sdk)](https://www.npmjs.com/package/@koyeb/sandbox-sdk)

## Overview

The **Koyeb Sandbox SDK** enables you to manage and interact with ephemeral sandboxes on [Koyeb](https://www.koyeb.com/), a modern cloud infrastructure provider. Sandboxes are secure, isolated environments designed to execute untrusted or user-supplied code safely.

This SDK is ideal for building online code runners, education platforms, CI/CD systems, and any application that requires secure, on-demand code execution.

- ⚡ **Ephemeral environments**: Create, manage, and destroy sandboxes programmatically
- 🔒 **Secure execution**: Run untrusted code with strong isolation
- 📁 **Filesystem management**: Upload / download files, create directories and more
- ⚙️ **Background processes**: Start and manage background processes
- 🟦 **TypeScript support**: Fully typed for a great developer experience

## Installation

```sh
npm install @koyeb/api-client-js @koyeb/sandbox-sdk
```

Set your [API access token](https://app.koyeb.com/settings/api) before using the SDK:

```sh
export KOYEB_API_TOKEN="<your-api-token>"
```

## Quick Start

```js
import { Sandbox } from '@koyeb/sandbox-sdk';

async function main() {
  const sandbox = await Sandbox.create();

  const { stdout } = await sandbox.exec("echo 'Hello from Koyeb Sandbox!'");
  console.log(stdout.trim());

  await sandbox.delete();
}

main().catch(console.error);
```

See [more examples](./examples).

## Creating Sandboxes

### `Sandbox.create(options?)`

Creates a new sandbox.

#### Options

| Option                             | Description                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `image`                            | Docker image to boot. Defaults to `koyeb/sandbox`.                                                                                  |
| `name`                             | Name shown in Koyeb and used in resource names.                                                                                     |
| `wait_ready`                       | Wait until the sandbox becomes healthy (enabled by default)                                                                         |
| `instance_type`                    | Instance size to provision. Defaults to `micro`.                                                                                    |
| `exposed_port_protocol`            | Protocol used by the exposed port (one of `http \| http2`).                                                                         |
| `env`                              | Environment variables injected into the container.                                                                                  |
| `region`                           | Koyeb region slug. Defaults to `'na'` (north america).                                                                              |
| `api_token`                        | API token for authentication, overriding `process.env.KOYEB_API_TOKEN`.                                                             |
| `timeout`                          | Seconds to wait while checking readiness.                                                                                           |
| `idle_timeout`                     | Seconds before the sandbox scales to zero. Set `0` to disable sleep.                                                                |
| `enable_tcp_proxy`                 | Enable TCP proxying on port 3031.                                                                                                   |
| `privileged`                       | Run the sandbox in privileged mode.                                                                                                 |
| `registry_secret`                  | Name of the Koyeb registry secret required to pull private images.                                                                  |
| `delete_after_delay`               | Time to wait before automatically deleting the sandbox after creation.                                                              |
| `delete_after_inactivity_delay`    | Time to wait before automatically deleting the sandbox after inactivity.                                                            |
| `_experimental_enable_light_sleep` | When enabled, uses idle_timeout for light_sleep and sets deep_sleep=3900.                                                           |
| `block_network`                    | Block all outbound network access. Mutually exclusive with `outbound_allowlist`.                                                    |
| `outbound_allowlist`               | IPs/CIDRs allowed as outbound destinations; all other traffic is blocked. Bare IPs are normalized to `/32` (IPv4) or `/128` (IPv6). |
| `poll_interval`                    | Seconds between readiness polls (defaults to `0.5`).                                                                                |
| `cleanup_on_failure`               | Best-effort delete of the sandbox when readiness fails (default `true`). Pass `false` to keep a failed sandbox for inspection.       |

### `Sandbox.get_from_id(serviceId, apiToken?, host?)`

Load an existing Sandbox from a Koyeb service ID. Useful for long-lived integrations.

### `Sandbox.list(options?)`

List every sandbox service as lazy handles: `options` accepts `app_id` and `name` filters plus `api_token` and `host` overrides. Handles carry no executor secret — connected operations (commands, filesystem) raise `NoSandboxSecretError`, while health checks keep polling to their timeout; reconnect with `Sandbox.get_from_id(handle.id)`.

## Claiming Sandboxes from a Pool

Service pools keep prewarmed sandboxes ready to claim. Claiming is idempotent: replaying a claim with the same `(pool_id, request_id)` pair always returns the same claim — the API never provisions a second sandbox or consumes another pool member.

> **Note:** the pool claim and service pool APIs require `@koyeb/api-client-js` ≥ 1.3.0.

### `claim(poolId, options?)`

Claims a sandbox from a pool and returns a `ClaimResult` with `claim_id`, `pool_id`, `request_id`, `service_id` and `prewarmed`.

- **Warm path** (`prewarmed: true`): the claimed sandbox is already running and ready to use.
- **Cold path** (`prewarmed: false`): a new sandbox service is created on demand. `service_id` is returned immediately; wait for it with [`wait_claim_ready`](#wait_claim_readyclaimorserviceid-options).

The SDK retries HTTP `429` and `5xx` responses automatically, reusing the same `request_id`, so retries never double-claim. Failures without an HTTP status (e.g. network errors) are not retried.

| Option         | Description                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `request_id`   | Idempotency key of the claim. Generated once (UUID v4) when omitted and preserved across retries. |
| `api_token`    | API token for authentication, overriding `process.env.KOYEB_API_TOKEN`.                           |
| `host`         | Target API host, overriding `KOYEB_API_HOST`.                                                     |
| `max_attempts` | Max claim attempts on retryable failures (`429`/`5xx`). Defaults to 3.                            |
| `retry_delay`  | Base delay in seconds between attempts; the wait is `retry_delay` × attempt. Defaults to 1.       |

### `get_claim(claimId, options?)`

Fetches a claim's current state (`UNSPECIFIED`, `PENDING`, `FULFILLED`, `FAILED` or `RELEASED`).

| Option      | Description                                                             |
| ----------- | ----------------------------------------------------------------------- |
| `api_token` | API token for authentication, overriding `process.env.KOYEB_API_TOKEN`. |

### `wait_claim_ready(claimOrServiceId, options?)`

Cold-path helper: polls Get Service until the claimed sandbox is ready. Accepts a `ClaimResult` or a service ID.

Resolves to `true` once the service is `HEALTHY` or `DEGRADED` (usable), or `false` if it is not ready within `timeout` seconds. Throws `ServiceTerminalStateError` as soon as the service reaches a state it cannot recover from — unknown statuses included (fail closed).

| Service status                                                   | Outcome          |
| ---------------------------------------------------------------- | ---------------- |
| `HEALTHY`, `DEGRADED`                                            | Ready            |
| `STARTING`, `RESUMING`                                           | Keep polling     |
| `UNHEALTHY`, `DELETING`, `DELETED`, `PAUSING`, `PAUSED`, unknown | Terminal failure |

| Option          | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `timeout`       | Seconds to wait before giving up. Defaults to 300.                      |
| `poll_interval` | Seconds between Get Service polls. Defaults to 2.                       |
| `api_token`     | API token for authentication, overriding `process.env.KOYEB_API_TOKEN`. |
| `signal`        | `AbortSignal` to stop waiting early.                                    |

```js
import { Sandbox, claim, wait_claim_ready } from '@koyeb/sandbox-sdk';

const claimed = await claim('my-pool');
console.log(claimed.prewarmed ? 'Warm claim' : 'Cold claim');

if (!claimed.prewarmed) {
  const ready = await wait_claim_ready(claimed, { timeout: 300 });
  if (!ready) throw new Error('Claimed sandbox was not ready in time');
}

const sandbox = await Sandbox.get_from_id(claimed.service_id);
await sandbox.exec('echo ready');
await sandbox.delete();
```

## Managing Service Pools

Service pools keep a set of pre-provisioned sandboxes warm so a claim is fulfilled immediately. The pool's `definition` is a `DeploymentDefinition` built from the same curated flags as `Sandbox.create` — `type` defaults to `SANDBOX`; `WEB` and `WORKER` definitions are accepted (with their own `ports`/`routes`), and `DATABASE` is rejected. SANDBOX pools always carry the executor's auto wiring (ports 3030/3031) and keep mesh `AUTO`.

### `ServicePool.create(name, options?)`

Creates a new service pool.

| Option                             | Description                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `size`                             | Target number of pre-warmed sandboxes. Defaults to 1.                                   |
| `type`                             | Definition type: `SANDBOX` (default), `WEB`, or `WORKER`. `DATABASE` is rejected.        |
| `image`                            | Docker image. Defaults to `koyeb/sandbox`.                                              |
| `instance_type`                    | Instance size. Defaults to `micro`.                                                     |
| `region`                           | Region slug. Defaults to `na`.                                                          |
| `env`                              | Environment variables.                                                    |
| `config_files`                     | Config files with optional permissions.                                                 |
| `privileged`                       | Run in privileged mode.                                                                 |
| `registry_secret`                  | Registry secret name for private images.                                                |
| `ports` / `routes`                 | Explicit member wiring (non-SANDBOX types only; rejected on SANDBOX pools).              |
| `exposed_port_protocol`            | Protocol for the exposed port (`http` or `http2`; SANDBOX only).                        |
| `enable_tcp_proxy`                 | Enable TCP proxying on port 3031 (SANDBOX only).                                       |
| `idle_timeout`                     | Seconds before members scale to zero. Set 0 to disable.                                 |
| `block_network`                    | Block all outbound network. Mutually exclusive with `outbound_allowlist`.               |
| `outbound_allowlist`               | IPs/CIDRs allowed as outbound; all other traffic blocked.                               |
| `_experimental_enable_light_sleep` | Enable light sleep with `idle_timeout`.                                                 |
| `api_token` / `host`               | API token and API host overrides.                                                       |

### `ServicePool.get(poolId, options?)`

Fetch a pool by id. `options`: `api_token`.

### `ServicePool.list(options?)`

List pools, optionally filtered by name. `options`: `name`, `limit`, `offset`, `api_token`.

### `pool.update(options)`

Update the pool's size and/or definition. At least one must be provided. Returns a refreshed `ServicePool`.

### `pool.delete()`

Delete the pool (async server-side — `DELETING` status, fenced on active claims).

### `pool.refresh()`

Re-fetch the pool's current state. Returns a new `ServicePool`.

### `pool.claims(options?)`

List claims on this pool. `options`: `status`, `limit`, `offset`.

```js
import { ServicePool, claim, wait_claim_ready, Sandbox } from '@koyeb/sandbox-sdk';

const pool = await ServicePool.create('my-pool', { size: 2, image: 'koyeb/sandbox:slim' });
console.log(`Pool ${pool.id} — ${pool.ready_count}/${pool.size} ready`);

const claimed = await claim(pool.id);
if (!claimed.prewarmed) await wait_claim_ready(claimed, { timeout: 300 });

const sandbox = await Sandbox.get_from_id(claimed.service_id);
await sandbox.exec('echo ready');
await sandbox.delete();
await pool.delete();
```

## Sandbox Lifecycle & Metadata

| Method                                                   | Description                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `wait_ready(timeout?, pollInterval?, signal?)`           | Polls health until success or timeout. Resolves to `true` on success.            |
| `wait_tcp_proxy_ready(timeout?, pollInterval?, signal?)` | Polls until TCP proxy information becomes available.                             |
| `is_healthy()`                                           | Performs a `/health` check against the sandbox URL.                              |
| `get_sandbox_url()`                                      | Returns the HTTPS URL (`https://<domain>/koyeb-sandbox`).                        |
| `get_tcp_proxy_info()`                                   | Returns `[host, publicPort]` once the TCP proxy is ready, otherwise `undefined`. |
| `get_domain()`                                           | Fetches and caches the sandbox domain metadata.                                  |
| `update_lifecycle()`                                     | Change the auto deletion properties.                                             |
| `update_network_policy(values?)`                         | Update the egress policy (block, allowlist, or reset). Triggers a redeployment.  |
| `delete()`                                               | Tears down the underlying service.                                               |

## Command Execution

| Method                       | Description                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `exec(cmd, options?)`        | Runs a command and resolves with `{ stdout, stderr, code }`.                                                                           |
| `exec_stream(cmd, options?)` | Streams command output using Server-Sent Events. Emits `stdout`, `stderr`, `exit`, and `end`.          |

`exec` options: `cwd`, `env`, `timeout` (seconds, default `30`), `on_stdout`/`on_stderr` (streaming callbacks; when set, output is no longer buffered), `stream` (default `true` consumes Server-Sent Events, `false` buffers server-side), `raise_on_error` (default `false`; when `true`, a non-zero exit raises `SandboxCommandError`), and `signal` (`AbortSignal`).

### Streaming Example

```js
const stream = sandbox.exec_stream('npm test');

stream.addEventListener('stdout', ({ data }) => {
  process.stdout.write(`${data.data}\n`);
});

stream.addEventListener('stderr', ({ data }) => {
  process.stderr.write(`${data.data}\n`);
});

stream.addEventListener('exit', ({ data }) => {
  process.stderr.write(`Exit code: ${data.code}\n`);
});

stream.addEventListener('end', () => {
  console.log('Command finished');
});
```

For callback-based streaming without event listeners, `exec` accepts `on_stdout`/`on_stderr` directly.

## Port Exposure

| Method                 | Description                                                                       |
| ---------------------- | --------------------------------------------------------------------------------- |
| `expose_port(port)`    | Binds a sandbox port to the public domain. Resolves `{ port, exposed_at }`.       |
| `unexpose_port(port?)` | Unbinds the exposed port. Pass a specific port or omit to unbind the current one. |

## Process Management

| Method                          | Description                                                |
| ------------------------------- | ---------------------------------------------------------- |
| `launch_process(cmd, options?)` | Starts a long-lived background process and returns its ID. |
| `kill_process(processId)`       | Stops a process started with `launch_process`.             |
| `list_processes()`              | Lists processes with their status.                         |
| `kill_all_processes()`          | Stops every running sandbox process and returns the count. |

## Filesystem Helpers

Access via `sandbox.filesystem`. Operations run over the sandbox API and fall back to `exec` only when needed.

| Method                                 | Description                                           |
| -------------------------------------- | ----------------------------------------------------- |
| `mkdir(path, recursive?)`              | Create a directory.                                   |
| `list_dir(path?)`                      | List entries inside a directory. Defaults to `.`.     |
| `delete_dir(path)`                     | Delete a directory tree.                              |
| `write_file(path, content)`            | Create or replace a text file.                        |
| `write_files(files)`                   | Bulk write helper for multiple files.                 |
| `read_file(path)`                      | Fetch `{ content, encoding }` for a remote file.      |
| `rename_file(oldPath, newPath)`        | Rename using an internal `mv` command.                |
| `move_file(src, dst)`                   | Move a file; maps `NO_SUCH_FILE` to `SandboxFileNotFoundError`. |
| `delete_file(path)`                     | Delete a single file via the executor endpoint.       |
| `rm(path, recursive?)`                 | Remove a file or directory (`rm -rf` when recursive). |
| `exists(path)`                         | Return `true` if the path exists.                     |
| `is_file(path)`                        | Return `true` if the path is a regular file.          |
| `is_dir(path)`                         | Return `true` if the path is a directory.             |
| `upload_file(localPath, remotePath)`   | Read a local file and upload it.                      |
| `download_file(localPath, remotePath)` | Download a sandbox file to disk.                      |

## Snapshots

Snapshots capture a sandbox's filesystem (or full state) so new sandboxes boot pre-configured.

```ts
// Snapshot a running sandbox
const snapshot = await sandbox.snapshot('my-snapshot');

// Boot a new sandbox from it
const clone = await Snapshot.get('my-snapshot').then((s) => s.spawn('clone'));

// Or inline at creation time
const other = await Sandbox.create({ snapshot: 'my-snapshot', name: 'sbx' });
```

- `sandbox.snapshot(name, options?)` — snapshot the first running instance; waits for availability by default (`snapshot_type: 'FULL'` captures full state).
- `Snapshot.get(id)` / `Snapshot.list({ type, status, name, limit, offset })` — fetch snapshots.
- `snapshot.refresh()` / `snapshot.wait_available(timeout?, pollInterval?)` / `snapshot.delete()`.
- `snapshot.spawn(name?, options?)` — boot a new sandbox from the snapshot.
- `Sandbox.create({ snapshot, ... })` — create with `instance_snapshot_id`; a `FULL` snapshot omits the definition (the API infers it).

## Templates

Build a snapshot from a declarative recipe: the SDK runs your files and commands on a throwaway builder sandbox, snapshots the result, and tears the builder down.

```ts
const snapshot = await Sandbox.template('node-ci', 'node:22-slim', { workdir: '/workspace' })
  .file('package.json', '{"name":"ci","dependencies":{"axios":"^1.7.0"}}')
  .copy('./local-dir', '/workspace/dir')
  .run('npm install', '/workspace')
  .build();

const sandbox = await snapshot.spawn('runner');
```

## Error Types

The SDK exports the following error classes for granular handling. Every one of them extends `SandboxError`, so a single `catch` covers the whole SDK — including API failures.

- `SandboxError` — base class for every SDK failure
- `MissingApiTokenError`
- `InvalidPortError`
- `SandboxTimeoutError`
- `NoSandboxSecretError`
- `SandboxRequestError` — executor non-OK responses (carries `status_code` + `body`)
- `SandboxApiError` — non-2xx API responses (carries `status` + `body`)
- `SandboxServiceError` — executor 5xx responses after the retry budget (extends `SandboxRequestError`)
- `SandboxCommandError` — a command exited non-zero while `raise_on_error` was opted in (carries the command `result`)
- `SandboxDeploymentError` — the sandbox deployment reached a terminal error state
- `EgressPolicyError`
- `PoolClaimError`
- `ServiceTerminalStateError`
- `ServicePoolError`
- `SandboxFilesystemError` (+ `SandboxFileNotFoundError`, `SandboxFileExistsError`)

## Contributing

Install dependencies with `pnpm install`. Run `pnpm build` to compile TypeScript into `lib/`, and `pnpm test` to run the test suite.

Need help? Reach out on [community.koyeb.com](https://community.koyeb.com).

## Releasing a new version

Releases are published manually to the public npm registry as [`@koyeb/sandbox-sdk`](https://www.npmjs.com/package/@koyeb/sandbox-sdk).

Prerequisites:

- Publish rights on the `@koyeb` npm organization.
- Log in against the public registry (required if your global npm registry points elsewhere):

  ```bash
  npm login --registry=https://registry.npmjs.org/
  npm whoami --registry=https://registry.npmjs.org/
  ```

Release steps:

```bash
# 1. Bump the version (creates a commit and a git tag)
npm version patch   # or: minor / major

# 2. Build and publish (the release script recompiles lib/ before publishing)
pnpm release

# 3. Push the version commit and tag
git push --follow-tags
```

Notes:

- `publishConfig` in `package.json` forces the publish to `registry.npmjs.org` with public access, so it works regardless of your global npm registry.
- The `release` script runs `pnpm build` explicitly, so the published `lib/` is always fresh even when npm lifecycle scripts are disabled (`ignore-scripts=true`).
- `pnpm publish` requires a clean git working tree; commit your changes first, or pass `--no-git-checks` to bypass the check.

## License

This project is licensed under the Apache-2.0 License. See [LICENSE](LICENSE) for details.
