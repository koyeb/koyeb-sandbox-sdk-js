# Koyeb Sandbox JavaScript SDK

This SDK allows to manage sandboxes within the Koyeb platform.

## Example

_Synchronous_

```ts
import { Sandbox } from '@koyeb/sandbox-sdk';

// or Sandbox.get_from_id(serviceId)
const sandbox = await Sandbox.create();

const python_code = `#!/usr/bin/env python3
print('Hello from Python!')
`;

try {
  const fs = sandbox.filesystem();

  await fs.write_file('/tmp/script.py', python_code);
  await sandbox.exec('chmod +x /tmp/script.py');

  const result = await sandbox.exec('/tmp/script.py');

  console.log(result.stdout);
} finally {
  sandbox.delete();
}
```

_Streaming_

```ts
import { Sandbox } from '@koyeb/sandbox-sdk';

const python_code = `#!/usr/bin/env python3

import time

for i in range(1, 10):
  print("line %d" % i)
  time.sleep(0.2)
`;

const sandbox = await Sandbox.create();

try {
  await sandbox.filesystem.write_file('/tmp/script.py', python_code);
  await sandbox.exec('chmod +x /tmp/script.py');

  const exec = sandbox.execStream('/tmp/script.py');

  exec.addEventListener('stderr', ({ data }) => console.log(`stderr: ${data.data}`));
  exec.addEventListener('stdout', ({ data }) => console.log(`stdout: ${data.data}`));
  exec.addEventListener('exit', ({ data }) => console.log(`exit: ${data.code}`));
  exec.addEventListener('end', () => console.log('end'));
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
