import { describe, expect, it, vi } from 'vitest';

import { CommandRunner, type CommandPort } from './command-runner.js';
import { SandboxCommandError, SandboxError } from './errors.js';
import { completeEvent, outputEvent, sseResponse } from './test-support.js';

function fakePort(overrides: Partial<CommandPort> = {}): CommandPort {
  return {
    name: 'sbx',
    post: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    raw: vi.fn(async () => sseResponse([completeEvent({ code: 0, error: false })])),
    ...overrides,
  };
}

describe('CommandRunner', () => {
  it('runs buffered commands through the post seam and normalizes partial replies', async () => {
    const post = vi.fn(async () => ({ stderr: 'warn' } as never));
    const runner = new CommandRunner(fakePort({ post }));

    const result = await runner.run('cmd', { stream: false });

    expect(post.mock.calls[0]).toEqual(['/run', { method: 'POST', signal: expect.any(AbortSignal) }, { cmd: 'cmd', cwd: undefined, env: undefined }, { onAttempt: expect.any(Function) }]);
    expect(result).toEqual({ stdout: '', stderr: 'warn', code: 0 });
  });

  it('reassembles the SSE stream through the raw seam', async () => {
    const raw = vi.fn(async (_path: string, _init: RequestInit, _body?: unknown) =>
      sseResponse([outputEvent('stdout', 'a'), outputEvent('stderr', 'b'), completeEvent({ code: 3, error: false })]),
    );
    const runner = new CommandRunner(fakePort({ raw }));

    const result = await runner.run('cmd');

    expect(raw.mock.calls[0][0]).toBe('/run_streaming');
    expect(result).toEqual({ stdout: 'a', stderr: 'b', code: 3 });
  });

  it('raises SandboxCommandError when opted in', async () => {
    const runner = new CommandRunner(fakePort({ post: vi.fn(async () => ({ code: 9 }) as never) }));

    const error = await runner.run('boom', { stream: false, raise_on_error: true }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxCommandError);
    expect((error as SandboxCommandError).result).toMatchObject({ command: 'boom', code: 9 });
  });

  it('dispatches transport failures from stream() as error events', async () => {
    // gateway.raw maps non-OK to a thrown SandboxError; stream() relays it as an event.
    const runner = new CommandRunner(
      fakePort({ raw: vi.fn(async () => Promise.reject(new SandboxError('service error'))) }),
    );

    const stream = runner.stream('boom');
    const error = await new Promise<unknown>((resolve, reject) => {
      stream.addEventListener('error', (event) => resolve((event as MessageEvent).data));
      setTimeout(() => reject(new Error('no error event within 1s')), 1_000);
    });

    expect(error).toBeInstanceOf(SandboxError);
  });
});
