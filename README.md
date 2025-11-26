# Koyeb Sandbox JavaScript SDK

This SDK allows to manage sandboxes within the Koyeb platform.

## Example

```ts
import { Sandbox } from '@koyeb/sandbox-sdk';

// or Sandbox.get_from_id(serviceId)
const sandbox = await Sandbox.create({ name: 'file-ops', region: 'fra' });

try {
  const fs = sandbox.filesystem();

  await fs.write_file('/tmp/script.py', "#!/usr/bin/env python3\nprint('Hello from Python!')");
  await sandbox.exec('chmod +x /tmp/script.py');

  const result = await sandbox.exec('/tmp/script.py');

  console.log(result.stdout);
} finally {
  sandbox.delete();
}
```

## Docs

_Sandbox.create_ parameters (all are optional)

- image: docker image to run
- name: sandbox service's name in Koyeb
- wait_ready: wait for service to be available before resolving
- instance_type: type of instance to use to run the sandbox
- region: the region in which the sandbox should be deployed
- exposed_port_protocol: either 'http' or 'http2'
- env: a record of environment variables
- api_token: a Koyeb API token
- timeout: time to wait for the sandbox to be healthy
- idle_timeout: time before the sandbox goes to sleep when there is no activity
- enable_tcp_proxy: enable direct TCP access to the sandbox
- privileged: run in privileged mode
