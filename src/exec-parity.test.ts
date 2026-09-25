import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_COMMAND_TIMEOUT } from './constants.js';
import { SandboxCommandError, SandboxError, SandboxTimeoutError } from './errors.js';
import { Sandbox, type ExecResult } from './sandbox.js';
import {
  completeEvent as complete,
  makeSandbox,
  outputEvent as output,
  sseResponse,
} from './test-support.js';
import type { ExecOptions } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exec parity with the Python SDK', () => {
  it('defaults to the Python 30s command timeout', () => {
    expect(DEFAULT_COMMAND_TIMEOUT).toBe(30);
  });

  it('streams by default, buffering stdout/stderr and the exit code', async () => {
    const sandbox = makeSandbox();
    const fetch = vi.spyOn(sandbox, 'fetch').mockResolvedValue(
      sseResponse([
        output('stdout', 'hel'),
        output('stdout', 'lo'),
        output('stderr', 'warn'),
        complete({ code: 0, error: false }),
      ]),
    );

    const result = await sandbox.exec('echo hello');

    expect(fetch.mock.calls[0]).toMatchObject(['/run_streaming', { method: 'POST' }, { cmd: 'echo hello' }]);
    expect(result).toEqual({ stdout: 'hello', stderr: 'warn', code: 0 });
  });

  it('feeds on_stdout/on_stderr chunks live and skips buffering, like Python', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(
      sseResponse([output('stdout', 'a'), output('stderr', 'b'), complete({ code: 0, error: false })]),
    );

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await sandbox.exec('x', {
      on_stdout: (chunk) => stdout.push(chunk),
      on_stderr: (chunk) => stderr.push(chunk),
    });

    expect(stdout).toEqual(['a']);
    expect(stderr).toEqual(['b']);
    expect(result).toEqual({ stdout: '', stderr: '', code: 0 });
  });

  it('returns non-zero results untouched unless raise_on_error is opted in', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(sseResponse([complete({ code: 3, error: false })]));

    const result = await sandbox.exec('boom');

    expect(result).toEqual({ stdout: '', stderr: '', code: 3 });
  });

  it('raise_on_error throws SandboxCommandError with the Python message and result', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(
      sseResponse([output('stderr', 'kaput'), complete({ code: 2, error: false })]),
    );

    const error = await sandbox.exec('boom', { raise_on_error: true }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxCommandError);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxCommandError).message).toBe("Command 'boom' failed with exit code 2: kaput");
    expect((error as SandboxCommandError).result).toEqual({
      command: 'boom',
      stdout: '',
      stderr: 'kaput',
      code: 2,
    });
    // Python's CommandResult spells the exit code exit_code and carries success.
    expect((error as SandboxCommandError).exit_code).toBe(2);
    expect((error as SandboxCommandError).success).toBe(false);
  });

  it('normalizes partial buffered replies like Python response.get defaults', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'request').mockResolvedValue({ stderr: 'warn' } as never);

    const result = await sandbox.exec('cmd', { stream: false });

    expect(result).toEqual({ stdout: '', stderr: 'warn', code: 0 });
  });

  it('exposes the exec types from the package root', () => {
    const options: ExecOptions = { timeout: 5, stream: false };
    const result: ExecResult = { stdout: '', stderr: '', code: 0 };

    expect(options).toBeDefined();
    expect(result).toBeDefined();
  });

  it('stream:false posts to /run and applies raise_on_error to the buffered reply', async () => {
    const sandbox = makeSandbox();
    const request = vi
      .spyOn(sandbox, 'request')
      .mockResolvedValue({ stdout: 'out', stderr: 'bad', code: 9 } as never);

    const result = await sandbox.exec('cmd', { stream: false });
    expect(request.mock.calls[0][0]).toBe('/run');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(result).toEqual({ stdout: 'out', stderr: 'bad', code: 9 });

    const error = await sandbox.exec('cmd', { stream: false, raise_on_error: true }).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(SandboxCommandError);
    expect((error as SandboxCommandError).result).toMatchObject({ code: 9, stderr: 'bad' });
  });

  it('maps a string error payload to a failed command start, like Python', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(sseResponse([complete({ error: 'failed to start' })]));

    const result = await sandbox.exec('boom');

    expect(result).toEqual({ stdout: '', stderr: 'failed to start', code: 1 });
  });

  it('maps deadline aborts to the Python timeout error', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockImplementation(async (_path, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });

    const error = await sandbox.exec('sleep 100', { timeout: 0.05 }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxTimeoutError);
    expect((error as Error).message).toBe('Request timed out after 0.05s');
  });

  it('propagates caller aborts untouched', async () => {
    const sandbox = makeSandbox();
    const controller = new AbortController();
    vi.spyOn(sandbox, 'fetch').mockImplementation(async (_path, init) => {
      controller.abort();
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener('abort', abort);
      });
    });

    const error = await sandbox.exec('x', { signal: controller.signal }).catch((error: unknown) => error);

    expect(error).not.toBeInstanceOf(SandboxTimeoutError);
    expect((error as Error).message).toContain('aborted');
  });
});

describe('exec deadline parity', () => {
  function sseBody(
    signal: AbortSignal | null | undefined,
    produce: (emit: (chunk: string) => void, done: () => void) => Promise<void>,
  ) {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        // Mirror undici: aborting the request errors the body mid-read.
        const onAbort = () => controller.error(new DOMException('This operation was aborted', 'AbortError'));
        signal?.addEventListener('abort', onAbort);
        try {
          await produce(
            (chunk) => controller.enqueue(encoder.encode(chunk)),
            () => controller.close(),
          );
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      },
    });
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('re-arms the deadline on every chunk, like a per-read timeout', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockImplementation(async (_path, init) => {
      // A chunk every 40ms for 400ms: total runtime far exceeds the 0.25s
      // deadline, but each 40ms gap is well inside it.
      const body = sseBody(init.signal, async (emit, done) => {
        for (let i = 0; i < 10; i++) {
          await sleep(40);
          emit(output('stdout', `chunk-${i}`));
        }
        emit(complete({ code: 0, error: false }));
        done();
      });
      return new Response(body, { status: 200 });
    });

    const result = await sandbox.exec('long-running', { timeout: 0.25 });

    expect(result.stdout).toBe('chunk-0chunk-1chunk-2chunk-3chunk-4chunk-5chunk-6chunk-7chunk-8chunk-9');
    expect(result.code).toBe(0);
  });

  it('aborts a stream that stays silent past the deadline', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockImplementation(async (_path, init) => {
      const body = sseBody(init.signal, async (emit, done) => {
        emit(output('stdout', 'one'));
        await sleep(400);
        emit(complete({ code: 0, error: false }));
        done();
      });
      return new Response(body, { status: 200 });
    });

    const error = await sandbox.exec('stall', { timeout: 0.1 }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxTimeoutError);
    expect((error as Error).message).toBe('Request timed out after 0.1s');
  });

  it('forwards caller aborts with one in-flight listener and cleans it up', async () => {
    const sandbox = makeSandbox();
    const controller = new AbortController();
    let release: (value: unknown) => void = () => {};
    vi.spyOn(sandbox, 'request').mockImplementation(async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { stdout: '', stderr: '', code: 0 };
    });

    const pending = sandbox.exec('x', { stream: false, signal: controller.signal });
    await sleep(0);
    // Exactly one forwarding listener while in flight — none left behind after.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    controller.abort();
    release(undefined);
    const error = await pending.catch((error: unknown) => error);

    expect(error).not.toBeInstanceOf(SandboxTimeoutError);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('SSE parser robustness', () => {
  it('parses a final event with no trailing blank line', async () => {
    const sandbox = makeSandbox();
    // EOF-terminated: the stream ends right after the complete event.
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(
      sseResponse([output('stdout', 'hi'), `event: complete\ndata: ${JSON.stringify({ code: 7, error: false })}`]),
    );

    const result = await sandbox.exec('x');

    expect(result).toEqual({ stdout: 'hi', stderr: '', code: 7 });
  });

  it('prefers an explicit exit code over an error field, like Python', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(
      sseResponse([complete({ code: 5, error: 'weird payload' })]),
    );

    const result = await sandbox.exec('x');

    expect(result).toEqual({ stdout: '', stderr: '', code: 5 });
  });

  it('handles the executor error event for failed command starts', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(
      sseResponse([`event: error\ndata: ${JSON.stringify({ error: 'Failed to start command' })}\n\n`]),
    );

    const result = await sandbox.exec('broken');

    expect(result).toEqual({ stdout: '', stderr: 'Failed to start command', code: 1 });
  });

  it('turns malformed event data into a failed result like Python', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(
      sseResponse(['event: complete\ndata: {not json}\n\n']),
    );

    const result = await sandbox.exec('x');

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Failed to parse event data');
  });

  it('keeps multi-byte characters split across chunks intact', async () => {
    const payload = 'héllo→';
    const bytes = new TextEncoder().encode(
      `event: output\ndata: ${JSON.stringify({ stream: 'stdout', data: payload })}\n\n` +
        `event: complete\ndata: ${JSON.stringify({ code: 0, error: false })}\n\n`,
    );
    // Cut inside the two-byte 'é' sequence so the chunks straddle it.
    const split = bytes.indexOf(0xc3) + 1;
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    const result = await sandbox.exec('x');

    expect(result.stdout).toBe(payload);
  });

  it('releases the stream and wraps lost connections in SandboxError, like Python', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: output\ndata:'));
        controller.error(new Error('wire cut'));
      },
    });
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));

    const error = await sandbox.exec('x').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxError);
    expect((error as Error).message).toBe('Connection to sandbox lost: Error: wire cut');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(body.locked).toBe(false);
  });

  it('passes caller aborts through the streaming route untouched', async () => {
    const sandbox = makeSandbox();
    const controller = new AbortController();
    vi.spyOn(sandbox, 'fetch').mockImplementation(async (_path, init) => {
      controller.abort();
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener('abort', abort);
      });
    });

    const error = await sandbox.exec('x', { signal: controller.signal }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as Error).message).toContain('aborted');
  });
});

describe('exec_stream exit events', () => {
  it('maps non-OK responses to the error event instead of hanging', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }));

    const stream = sandbox.exec_stream('boom');
    const error = await new Promise<unknown>((resolve, reject) => {
      stream.addEventListener('error', (event) => resolve((event as MessageEvent).data));
      setTimeout(() => reject(new Error('no error event within 1s')), 1_000);
    });

    expect(error).toBeInstanceOf(SandboxError);
  });

  it('emits exit with the completion payload before end', async () => {
    const sandbox = makeSandbox();
    vi.spyOn(sandbox, 'fetch').mockResolvedValue(
      sseResponse([output('stdout', 'hi'), complete({ code: 0, error: false })]),
    );

    const stream = sandbox.exec_stream('echo hi');
    const seen: unknown[] = [];
    stream.addEventListener('exit', (event) => seen.push((event as MessageEvent).data));
    stream.addEventListener('end', () => seen.push('end'));

    await new Promise<void>((resolve) => {
      stream.addEventListener('end', () => resolve());
      setTimeout(resolve, 100);
    });

    expect(seen).toEqual([{ code: 0, error: false }, 'end']);
  });
});
