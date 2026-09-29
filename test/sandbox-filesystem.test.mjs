import assert from 'node:assert/strict';
import test from 'node:test';

import { SandboxFilesystemError } from '../lib/errors.js';
import { SandboxFilesystem } from '../lib/sandbox-filesystem.js';

test('filesystem shell commands quote every path', async () => {
  const commands = [];
  const sandbox = {
    exec: async (command) => {
      commands.push(command);
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  const filesystem = new SandboxFilesystem(sandbox);

  await filesystem.rename_file("/tmp/a b'; touch /tmp/pwn", '/tmp/new name');
  await filesystem.exists('/tmp/a b');

  assert.equal(commands[0], `mv '/tmp/a b'"'"'; touch /tmp/pwn' '/tmp/new name'`);
  assert.equal(commands[1], `test -e '/tmp/a b'`);
});

test('filesystem methods reject executor error bodies', async () => {
  const sandbox = {
    request: async () => ({ error: 'disk full' }),
  };
  const filesystem = new SandboxFilesystem(sandbox);

  await assert.rejects(filesystem.write_file('/tmp/file', 'content'), SandboxFilesystemError);
});
