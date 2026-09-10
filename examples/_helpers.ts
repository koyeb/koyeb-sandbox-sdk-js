import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { Sandbox, type CreateSandboxOptions } from '@koyeb/sandbox-sdk';

export type CommandResult = { stdout: string; stderr: string; code: number };

export function requireApiToken(): string {
  const token = process.env.KOYEB_API_TOKEN;
  assert.ok(token, 'KOYEB_API_TOKEN must be set');
  return token;
}

export function exampleName(base: string): string {
  const suffix = process.env.GITHUB_RUN_ID ?? randomBytes(4).toString('hex');
  return `${base}-${suffix}`.slice(0, 63);
}

export function sandboxOptions(name: string, options: CreateSandboxOptions = {}): CreateSandboxOptions {
  return {
    api_token: requireApiToken(),
    project_id: process.env.KOYEB_PROJECT_ID || undefined,
    region: process.env.KOYEB_REGION || undefined,
    image: 'koyeb/sandbox:slim',
    name: exampleName(name),
    ...options,
  };
}

export async function withSandbox<T>(
  name: string,
  options: CreateSandboxOptions,
  run: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await Sandbox.create(sandboxOptions(name, options));
  try {
    return await run(sandbox);
  } finally {
    await sandbox.delete();
  }
}

export function assertCommand(result: CommandResult, label = 'command'): void {
  assert.equal(result.code, 0, `${label} failed: ${result.stderr}`);
}

export async function sleep(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
}

export async function retry<T>(run: () => Promise<T>, attempts = 10, delaySeconds = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delaySeconds);
    }
  }
  throw lastError;
}

export async function runExample(name: string, run: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===`);
  await run();
  console.log(`✓ ${name} passed`);
}
