import { describe, expect, it, vi } from 'vitest';

import { CommandRunner, type CommandPort } from './command-runner.js';
import { SandboxCommandError, SandboxError, SandboxTimeoutError } from './errors.js';
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

    expect(post.mock.calls[0]).toEqual([
      '/run',
      { method: 'POST', signal: undefined },
      { cmd: 'cmd', cwd: undefined, env: undefined },
      undefined,
      { timeout: 30 },
    ]);
    expect(result).toEqual({ stdout: '', stderr: 'warn', code: 0, command: 'cmd', duration: expect.any(Number) });
  });

  it('reassembles the SSE stream through the raw seam', async () => {
    const raw = vi.fn(async (_path: string, _init: RequestInit, _body?: unknown) =>
      sseResponse([outputEvent('stdout', 'a'), outputEvent('stderr', 'b'), completeEvent({ code: 3, error: false })]),
    );
    const runner = new CommandRunner(fakePort({ raw }));

    const result = await runner.run('cmd');

    expect(raw.mock.calls[0][0]).toBe('/run_streaming');
    expect(result).toEqual({ stdout: 'a', stderr: 'b', code: 3, command: 'cmd', duration: expect.any(Number) });
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

  it('reports an empty stream body as an error event instead of hanging', async () => {
    const runner = new CommandRunner(fakePort({ raw: vi.fn(async () => new Response(null, { status: 200 })) }));

    const stream = runner.stream('cmd');
    const error = await new Promise<unknown>((resolve, reject) => {
      stream.addEventListener('error', (event) => resolve((event as MessageEvent).data));
      setTimeout(() => reject(new Error('no error event within 1s')), 1_000);
    });

    expect(error).toBeInstanceOf(SandboxError);
    expect((error as Error).message).toBe('Sandbox executor returned an empty command stream');
  });

  it('aborts a silent stream past its deadline, like a per-read timeout', async () => {
    const runner = new CommandRunner(
      fakePort({
        raw: vi.fn(async (_path: string, init: RequestInit) => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              const onAbort = () => controller.error(new DOMException('aborted', 'AbortError'));
              if (init.signal?.aborted) onAbort();
              else init.signal?.addEventListener('abort', onAbort);
            },
          });
          return new Response(body, { status: 200 });
        }),
      }),
    );

    const stream = runner.stream('cmd', { timeout: 0.05 });
    const error = await new Promise<unknown>((resolve, reject) => {
      stream.addEventListener('error', (event) => resolve((event as MessageEvent).data));
      setTimeout(() => reject(new Error('no error event within 2s')), 2_000);
    });

    expect(error).toBeInstanceOf(SandboxTimeoutError);
    expect((error as Error).message).toBe('Request timed out after 0.05s');
  });

  it('keeps a chunk-producing stream alive past its per-read deadline', async () => {
    const runner = new CommandRunner(
      fakePort({
        raw: vi.fn(async (_path: string, init: RequestInit) => {
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              const onAbort = () => controller.error(new DOMException('aborted', 'AbortError'));
              if (init.signal?.aborted) onAbort();
              else init.signal?.addEventListener('abort', onAbort);
              try {
                for (let i = 0; i < 6; i++) {
                  await new Promise((resolve) => setTimeout(resolve, 40));
                  controller.enqueue(new TextEncoder().encode(outputEvent('stdout', `c-${i}`)));
                }
                controller.enqueue(new TextEncoder().encode(completeEvent({ code: 0, error: false })));
                controller.close();
              } catch {
                // the reader was aborted mid-enqueue
              }
            },
          });
          return new Response(body, { status: 200 });
        }),
      }),
    );

    const stream = runner.stream('cmd', { timeout: 0.1 });
    const chunks: string[] = []
    const ended = new Promise<string>((resolve, reject) => {
      stream.addEventListener('stdout', (event) => chunks.push((event as MessageEvent<{ data: string }>).data.data));
      stream.addEventListener('end', () => resolve('end'));
      stream.addEventListener('error', (event) => reject((event as MessageEvent).data));
      setTimeout(() => reject(new Error('no end event within 2s')), 2_000);
    });

    expect(await ended).toBe('end');
    expect(chunks).toEqual(['c-0', 'c-1', 'c-2', 'c-3', 'c-4', 'c-5']);
  });
});
