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

| Option                             | Description                                                              |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `image`                            | Docker image to boot. Defaults to `koyeb/sandbox`.                       |
| `name`                             | Name shown in Koyeb and used in resource names.                          |
| `wait_ready`                       | Wait until the sandbox becomes healthy (enabled by default)              |
| `instance_type`                    | Instance size to provision. Defaults to `micro`.                         |
| `exposed_port_protocol`            | Protocol used by the exposed port (one of `http \| http2`).              |
| `env`                              | Environment variables injected into the container.                       |
| `region`                           | Koyeb region slug. Defaults to `'na'` (north america).                   |
| `api_token`                        | API token for authentication, overriding `process.env.KOYEB_API_TOKEN`.  |
| `timeout`                          | Seconds to wait while checking readiness.                                |
| `idle_timeout`                     | Seconds before the sandbox scales to zero. Set `0` to disable sleep.     |
| `enable_tcp_proxy`                 | Enable TCP proxying on port 3031.                                        |
| `privileged`                       | Run the sandbox in privileged mode.                                      |
| `registry_secret`                  | Name of the Koyeb registry secret required to pull private images.       |
| `_experimental_enable_light_sleep` | When enable, uses idle_timeout for light_sleep and sets deep_sleep=3900. |

### `Sandbox.get_from_id(serviceId, apiToken?)`

Load an existing Sandbox from a Koyeb service ID. Useful for long-lived integrations.

## Sandbox Lifecycle & Metadata

| Method                                                   | Description                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `wait_ready(timeout?, pollInterval?, signal?)`           | Polls health until success or timeout. Resolves to `true` on success.            |
| `wait_tcp_proxy_ready(timeout?, pollInterval?, signal?)` | Polls until TCP proxy information becomes available.                             |
| `is_healthy()`                                           | Performs a `/health` check against the sandbox URL.                              |
| `get_sandbox_url()`                                      | Returns the HTTPS URL (`https://<domain>/koyeb-sandbox`).                        |
| `get_tcp_proxy_info()`                                   | Returns `[host, publicPort]` once the TCP proxy is ready, otherwise `undefined`. |
| `get_domain()`                                           | Fetches and caches the sandbox domain metadata.                                  |
| `delete()`                                               | Tears down the underlying service.                                               |

## Command Execution

| Method                       | Description                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `exec(cmd, options?)`        | Runs a command and resolves with `{ stdout, stderr, code }`. Supports `cwd`, `env`, and `AbortSignal`. |
| `exec_stream(cmd, options?)` | Streams command output using Server-Sent Events. Emits `stdout`, `stderr`, and `end`.                  |

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
| `rm(path, recursive?)`                 | Remove a file or directory (`rm -rf` when recursive). |
| `exists(path)`                         | Return `true` if the path exists.                     |
| `is_file(path)`                        | Return `true` if the path is a regular file.          |
| `is_dir(path)`                         | Return `true` if the path is a directory.             |
| `upload_file(localPath, remotePath)`   | Read a local file and upload it.                      |
| `download_file(localPath, remotePath)` | Download a sandbox file to disk.                      |

## Error Types

The SDK exports the following error classes for granular handling:

- `MissingApiTokenError`
- `InvalidPortError`
- `SandboxTimeoutError`
- `NoSandboxSecretError`
- `SandboxRequestError`

## Contributing

Install dependencies with `pnpm install` and run `pnpm build` to compile TypeScript into `lib/`.

Need help? Reach out on [community.koyeb.com](https://community.koyeb.com).

## License

This project is licensed under the Apache-2.0 License. See [LICENSE](LICENSE) for details.
