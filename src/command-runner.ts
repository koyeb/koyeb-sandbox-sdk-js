import { DEFAULT_COMMAND_TIMEOUT } from './constants.js';
import { SandboxCommandError, SandboxError, SandboxTimeoutError } from './errors.js';
import { handleServerSentEvents } from './server-sent-event.js';
import { TypedEventTarget } from './typed-event-target.js';
import { assert } from './prelude.js';

export type SandboxExec = TypedEventTarget<{
  stdout: MessageEvent<{ stream: 'stdout'; data: string }>;
  stderr: MessageEvent<{ stream: 'stderr'; data: string }>;
  exit: MessageEvent<{ code?: number; error?: boolean | string }>;
  end: Event;
  error: MessageEvent<unknown>;
}>;

/** Result of a command run through {@link Sandbox.exec} (Python: CommandResult). */
export type ExecResult = { stdout: string; stderr: string; code: number };

/** Options shared by the buffered and streaming exec routes. */
type ExecRouteOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeout: number;
  signal?: AbortSignal;
};

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /** Command timeout in seconds, enforced on the executor request (Python parity). */
  timeout?: number;
  /** Streaming stdout callback; when set, stdout is no longer buffered (Python parity). */
  on_stdout?: (chunk: string) => void;
  /** Streaming stderr callback; when set, stderr is no longer buffered (Python parity). */
  on_stderr?: (chunk: string) => void;
  /** Consume the SSE stream (default) or buffer server-side via /run. */
  stream?: boolean;
  /** Raise SandboxCommandError on non-zero exit (default false, Python parity). */
  raise_on_error?: boolean;
  signal?: AbortSignal;
};

/** The two transport calls the runner needs, injected so tests fake the seam directly. */
export type CommandPort = {
  readonly name: string;
  /** Retrying POST with body parsing and error mapping (Sandbox.request). */
  post: (path: string, init: RequestInit, body?: unknown, hooks?: { onAttempt?: () => void }) => Promise<any>;
  /** Single authorized request with non-OK mapping (ExecutorGateway.raw). */
  raw: (path: string, init: RequestInit, body?: unknown) => Promise<Response>;
};

/**
 * Command execution for the sandbox executor (Python's SandboxExecutor): route
 * choice, SSE reassembly, the per-read deadline, and opt-in raise-on-error.
 */
export class CommandRunner {
  constructor(private readonly port: CommandPort) {}

  async run(
    cmd: string,
    {
      cwd,
      env,
      timeout = DEFAULT_COMMAND_TIMEOUT,
      on_stdout,
      on_stderr,
      stream = true,
      raise_on_error = false,
      signal,
    }: ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await (stream
      ? this.runStreaming(cmd, { cwd, env, timeout, on_stdout, on_stderr, signal })
      : this.runBuffered(cmd, { cwd, env, timeout, signal }));

    if (raise_on_error && result.code !== 0) {
      throw new SandboxCommandError({ command: cmd, ...result });
    }

    return result;
  }

  /** Raw SSE emitter: stdout/stderr chunks, the exit payload, then end. */
  stream(cmd: string, { cwd, env, signal }: Pick<ExecOptions, 'cwd' | 'env' | 'signal'> = {}): SandboxExec {
    const emitter = new EventTarget();

    this.port
      .raw('/run_streaming', { method: 'POST', signal }, { cmd, cwd, env })
      .then((response) => response.body)
      .then((body) => body && handleServerSentEvents(emitter, body))
      .catch((error) => emitter.dispatchEvent(new MessageEvent('error', { data: error })));

    return emitter;
  }

  /** Buffered route: one POST to /run, carrying the retrying request machinery. */
  private async runBuffered(cmd: string, { cwd, env, timeout, signal }: ExecRouteOptions): Promise<ExecResult> {
    const deadline = new Deadline(timeout, signal);

    try {
      const reply = await this.port.post(
        '/run',
        { method: 'POST', signal: deadline.signal },
        { cmd, cwd, env },
        { onAttempt: () => deadline.arm() },
      );
      // Normalize like Python's response.get(...) so partial replies type-check.
      return { stdout: reply?.stdout ?? '', stderr: reply?.stderr ?? '', code: reply?.code ?? 0 };
    } catch (error) {
      throw deadline.mapFailure(error, this.port.name);
    } finally {
      deadline.dispose();
    }
  }

  /** Streaming route: reassembles the SSE events into a command result, like Python's exec. */
  private async runStreaming(
    cmd: string,
    {
      cwd,
      env,
      timeout,
      on_stdout,
      on_stderr,
      signal,
    }: ExecRouteOptions & Pick<ExecOptions, 'on_stdout' | 'on_stderr'>,
  ): Promise<ExecResult> {
    // Python parity: callbacks consume chunks live; output is only buffered when neither is set.
    const buffer = !on_stdout && !on_stderr;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let code = 0;
    let startError: string | undefined;

    const consume = (callback: ((chunk: string) => void) | undefined, chunks: string[]) => (event: Event) => {
      const chunk = (event as MessageEvent<{ data: string }>).data.data;
      if (callback) callback(chunk);
      else if (buffer) chunks.push(chunk);
    };
    const emitter = new EventTarget();
    emitter.addEventListener('stdout', consume(on_stdout, stdout));
    emitter.addEventListener('stderr', consume(on_stderr, stderr));
    emitter.addEventListener('exit', (event) => {
      const data = (event as MessageEvent<{ code?: number; error?: boolean | string }>).data;
      // Python checks "code" before "error": an explicit code always wins.
      if (typeof data.code === 'number') {
        code = data.code;
      } else if (typeof data.error === 'string') {
        startError = data.error;
      }
    });

    const deadline = new Deadline(timeout, signal);

    try {
      const response = await this.port.raw(
        '/run_streaming',
        { method: 'POST', signal: deadline.signal },
        { cmd, cwd, env },
      );

      assert(response.body);
      await handleServerSentEvents(emitter, response.body, () => deadline.arm());
    } catch (error) {
      throw deadline.mapStreamFailure(error, this.port.name);
    } finally {
      deadline.dispose();
    }

    if (startError !== undefined) {
      // Python parity: a start failure discards partial output and exits 1.
      return { stdout: '', stderr: startError, code: 1 };
    }

    return { stdout: stdout.join(''), stderr: stderr.join(''), code };
  }
}

/**
 * Command deadline mirroring httpx's read timeout: the timer re-arms on every
 * received chunk, so a command that keeps producing output never times out
 * while a silent one aborts after `timeout` seconds.
 */
class Deadline {
  private timer?: ReturnType<typeof setTimeout>;
  private fired = false;
  private readonly controller = new AbortController();
  private readonly onCallerAbort = () => this.controller.abort();

  constructor(
    private readonly timeout: number,
    private readonly callerSignal?: AbortSignal,
  ) {
    if (callerSignal) {
      callerSignal.addEventListener('abort', this.onCallerAbort, { once: true });

      if (callerSignal.aborted) {
        this.controller.abort();
      }
    }

    this.arm();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
    }, this.timeout * 1_000);
    // A pending deadline must never keep the event loop alive.
    this.timer.unref?.();
  }

  /** Distinguish deadline aborts from caller aborts: only the former are timeouts. */
  mapFailure(error: unknown, sandboxName: string): unknown {
    if (this.fired) {
      return new SandboxTimeoutError(sandboxName, this.timeout, `Request timed out after ${this.timeout}s`);
    }
    return error;
  }

  /**
   * Streaming failures map to the SDK taxonomy: timeouts map, typed errors and
   * caller aborts pass through, lost connections become SandboxError like Python.
   */
  mapStreamFailure(error: unknown, sandboxName: string): unknown {
    if (this.fired) {
      return new SandboxTimeoutError(sandboxName, this.timeout, `Request timed out after ${this.timeout}s`);
    }

    if (error instanceof SandboxError || this.aborted) {
      return error;
    }

    return new SandboxError(`Connection to sandbox lost: ${String(error)}`);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.callerSignal?.removeEventListener('abort', this.onCallerAbort);
  }
}
