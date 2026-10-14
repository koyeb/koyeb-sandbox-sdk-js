import { DEFAULT_EXECUTOR_RETRIES, DEFAULT_EXECUTOR_RETRY_DELAY_MS, DEFAULT_HTTP_TIMEOUT } from './constants.js';
import {
  SandboxConnectionError,
  SandboxError,
  SandboxRequestError,
  SandboxServiceError,
  SandboxTimeoutError,
} from './errors.js';
import { wait } from './time.js';

/** The low-level "authorize and send" primitive the gateway drives. */
export type ExecutorSend = (path: string, init: RequestInit, body?: unknown) => Promise<Response>;

/**
 * Transport policy for the sandbox executor, one level above the wire:
 * timeout, retry, body parsing, and the executor error taxonomy. Connection
 * resolution and header assembly stay with the send primitive; everything
 * that decides *how* a call behaves lives here.
 */
export class ExecutorGateway {
  constructor(
    private readonly send: ExecutorSend,
    private readonly options: { name?: string } = {},
  ) {}

  /** Retrying request with body parsing and error mapping. */
  // The default keeps the historical loose typing of `Sandbox.request`.
  async post<T = any>(
    path: string,
    init: RequestInit,
    body?: unknown,
    hooks?: { onAttempt?: () => void },
    requestOptions?: { timeout?: number },
  ): Promise<T> {
    // Transient executor unavailability (cold starts, restarts, 5xx, network
    // blips): retry with exponential backoff before failing (Python parity).
    let backoff = DEFAULT_EXECUTOR_RETRY_DELAY_MS;

    for (let attempt = 0; ; attempt++) {
      // Python re-arms the per-read timeout on every attempt.
      hooks?.onAttempt?.();

      // Python bounds every executor request; the budget is re-armed per attempt.
      const deadline = this.armRequestTimeout(init, requestOptions?.timeout ?? DEFAULT_HTTP_TIMEOUT);

      let response: Response;

      try {
        response = await this.send(path, { ...init, signal: deadline.signal }, body);
      } catch (error) {
        // The request budget ran out: a deadline, not an abort or a blip.
        if (deadline.timedOut()) {
          throw new SandboxTimeoutError(
            this.options.name ?? 'sandbox',
            deadline.timeout,
            `Request timed out after ${deadline.timeout}s`,
          );
        }

        // Abort-driven failures are not transient; fail fast without retries.
        if (init.signal?.aborted) {
          throw error;
        }

        if (attempt >= DEFAULT_EXECUTOR_RETRIES) {
          throw error instanceof SandboxError
            ? error
            : new SandboxConnectionError(`Request to sandbox executor failed: ${String(error)}`, {
                cause: error,
              });
        }

        await wait(backoff, init.signal ?? undefined);
        backoff *= 2;
        continue;
      } finally {
        deadline.dispose();
      }

      if (response.status >= 500 && attempt < DEFAULT_EXECUTOR_RETRIES) {
        // Free the connection before the retry and honor early aborts.
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }
        await wait(backoff, init.signal ?? undefined);
        backoff *= 2;
        continue;
      }

      return this.parse(response);
    }
  }

  /** Single authorized request: non-OK maps to the taxonomy, the body stays unread. */
  async raw(path: string, init: RequestInit, body?: unknown): Promise<Response> {
    const response = await this.send(path, init, body);

    if (!response.ok) {
      const text = await response.text();

      if (response.status >= 500) {
        throw new SandboxServiceError(response.status, text);
      }
      throw new SandboxRequestError(response.status, text);
    }

    return response;
  }

  /** Bounded health probe: the response status only, failures mean not healthy. */
  async health(signal = AbortSignal.timeout(5_000)): Promise<boolean> {
    try {
      return (await this.send('/health', { signal })).ok;
    } catch {
      return false;
    }
  }

  /**
   * One request budget: an abort controller combining the caller's signal with
   * a per-attempt timer, so a hung executor request fails instead of blocking.
   */
  private armRequestTimeout(init: RequestInit, timeout: number) {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const abortFromCaller = () => controller.abort((init.signal as AbortSignal | undefined)?.reason);

    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout * 1_000);
      // A pending budget must never keep the event loop alive.
      timer.unref?.();
    }

    if (init.signal?.aborted) {
      abortFromCaller();
    } else {
      init.signal?.addEventListener('abort', abortFromCaller, { once: true });
    }

    return {
      timeout,
      signal: controller.signal,
      timedOut: () => timedOut,
      dispose: () => {
        if (timer) {
          clearTimeout(timer);
        }
        init.signal?.removeEventListener('abort', abortFromCaller);
      },
    };
  }

  private async parse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('Content-Type');
    const body = contentType?.startsWith('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      if (response.status >= 500) {
        throw new SandboxServiceError(
          response.status,
          typeof body === 'string' ? body : JSON.stringify(body),
        );
      }
      throw new SandboxRequestError(response.status, body);
    }

    return body as T;
  }
}
