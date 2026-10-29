import {
  DEFAULT_EXECUTOR_RETRIES,
  DEFAULT_EXECUTOR_RETRY_DELAY_MS,
  DEFAULT_FILES_IDLE_TIMEOUT,
  DEFAULT_HTTP_TIMEOUT,
} from './constants.js';
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

/** One /files/stat entry: type (file|dir|symlink|other), octal mode, RFC 3339 UTC mtime. */
export type FileStatEntry = {
  type: string;
  size: number;
  mode: string;
  mtime: string;
  sha256?: string;
};

/** The PUT /files commit reply: the received size and the content digest. */
export type FilesPutReply = { size: number; sha256: string };

/** The multipart session reply: the id parts address, and the byte cap each part must fit. */
export type FilesUploadSession = { upload_id: string; max_part_size: number };

/** One half-open [start, end) span of received bytes. */
export type FilesUploadSpan = { start: number; end: number };

/** The session's progress report: half-open, sorted, coalesced ranges — never null. */
export type FilesUploadStatus = { size: number; ranges: FilesUploadSpan[] };

/** The commit reply: size always, sha256 only when the open promised one. */
export type FilesUploadCompleteReply = { size: number; sha256?: string };

/** A whole or ranged GET /files reply: the status (200 whole, 206 slice), the
 *  strong validator the executor sent (absent for size-0 pseudo-files), and
 *  the idle-bounded body stream. */
export type FilesReadRangeReply = {
  status: number;
  etag?: string;
  stream: AsyncGenerator<Uint8Array, void, unknown>;
};

/** What PUT /files accepts: bytes, or a stream the transport drains chunk by chunk. */
export type FilesPutContent = Uint8Array | ReadableStream<Uint8Array> | NodeJS.ReadableStream;

/** fetch's streaming request init: undici requires `duplex: 'half'` on stream bodies. */
type StreamedRequestInit = RequestInit & { duplex?: 'half' };

export type FilesPutOptions = {
  mode?: string;
  parents?: boolean;
  sha256?: string;
  signal?: AbortSignal;
};

/** One warning per handle: pre-v0.0.24 executors make every transfer legacy. */
const LEGACY_FILES_WARNING =
  'Sandbox executor has no streamed /files routes (pre-v0.0.24): file transfers use the legacy JSON routes';

/** A probe reply's status to a routes verdict (Python parity: _probe_verdict).
 *
 * 404: the route does not exist (legacy executor). 400: "path is required" —
 * the new executor answering. Anything else (401/403/429...) says nothing
 * about the routes: raise, so the caller leaves the probe uncached and the
 * next call tries again.
 */
function probeVerdict(status: number): boolean {
  if (status === 404) return false;
  if (status === 400) return true;
  throw new SandboxError(`Failed probing /files routes: HTTP ${status}`);
}

/** Wrap a non-2xx streamed response in the SDK taxonomy (Python parity: _raise_for_status). */
function raiseForFilesStatus(status: number, text: string): SandboxRequestError | SandboxServiceError {
  if (status >= 500) return new SandboxServiceError(status, text);
  return new SandboxRequestError(status, text);
}

/** Reject `promise` with `reason()` the moment `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, reason: () => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The idle budget of a streamed /files call: 60 s without progress aborts
 * the request, unlike the JSON routes' total-time cap. `touch()` re-arms the
 * window on every chunk that moves; a caller signal aborts it too. A
 * watchdog timeout surfaces as SandboxTimeoutError naming the bound; a
 * caller abort surfaces as the raw abort.
 */
class IdleTimeout {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private callerAbort?: { signal: AbortSignal; handler: () => void };
  private didFire = false;
  private readonly seconds: number;
  private readonly name: string;

  constructor(seconds: number, name: string) {
    this.seconds = seconds;
    this.name = name;
    this.arm();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Bind a caller signal: its abort cancels the request too. */
  attach(signal?: AbortSignal) {
    if (!signal) return;
    const abortFromCaller = () => this.controller.abort(signal.reason);
    if (signal.aborted) {
      abortFromCaller();
    } else {
      this.callerAbort = { signal, handler: abortFromCaller };
      signal.addEventListener('abort', abortFromCaller, { once: true });
    }
  }

  /** Activity observed: the idle window starts over. */
  touch() {
    this.clear();
    this.arm();
  }

  /** Stop the clock only — the caller's abort binding stays live mid-transfer. */
  clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** The transfer is over: stop the clock and release the caller's signal. */
  dispose() {
    this.clear();
    // Long-lived caller signals must not accumulate listeners across transfers.
    if (this.callerAbort) {
      this.callerAbort.signal.removeEventListener('abort', this.callerAbort.handler);
      this.callerAbort = undefined;
    }
  }

  /** The reason a race should reject with when the abort fires. */
  abortReason(): unknown {
    return this.controller.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }

  /** Timeout errors name the idle bound; anything else surfaces as-is. */
  classify(error: unknown): unknown {
    if (this.didFire) {
      return new SandboxTimeoutError(this.name, this.seconds, `Request timed out after ${this.seconds}s`);
    }
    return error;
  }

  private arm() {
    this.timer = setTimeout(() => {
      this.didFire = true;
      this.controller.abort(this.abortReason());
    }, this.seconds * 1_000);
    // A pending budget must never keep the event loop alive.
    this.timer.unref?.();
  }
}

/** Re-arm the idle window on every chunk pulled from a request body stream. */
function withIdleTouch(stream: ReadableStream<Uint8Array>, idle: IdleTimeout): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        idle.touch();
        controller.enqueue(chunk);
      },
    }),
  );
}

/** Bytes as a chunked stream: the socket's pulls re-arm the idle window. */
function chunkedStream(content: Uint8Array): ReadableStream<Uint8Array> {
  const chunkSize = 64 * 1024;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < content.length; offset += chunkSize) {
        controller.enqueue(content.subarray(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
}

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

  /** The cached /files-routes probe verdict: one probe per sandbox handle. */
  private filesRoutes?: boolean;
  private filesRoutesProbe?: Promise<boolean>;

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

  /**
   * Stat a file on the streamed /files routes (executor v0.0.24+).
   *
   * A small JSON GET: it keeps the retrying path and the 30 s total cap of
   * every other JSON route. The fs layer classifies status errors.
   */
  async filesStat(path: string): Promise<FileStatEntry> {
    const params = new URLSearchParams({ path });
    return this.post<FileStatEntry>(`/files/stat?${params}`, { method: 'GET' });
  }

  /**
   * Stream content to a file through PUT /files (executor v0.0.24+).
   *
   * One non-retrying request: a streamed body cannot be replayed, so unlike
   * `post` a failure here surfaces to the caller (the executor writes to a
   * temp file and renames, so a failed upload leaves the destination as it
   * was). The timeout bounds idle time (60 s), not total transfer time, and
   * the caller's AbortSignal is honored mid-flight.
   */
  async filesPut(path: string, content: FilesPutContent, options: FilesPutOptions = {}): Promise<FilesPutReply> {
    const params = new URLSearchParams({ path });
    if (options.mode !== undefined) {
      params.set('mode', options.mode);
    }
    if (options.parents) {
      params.set('parents', '1');
    }

    const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
    if (options.sha256) {
      headers.set('X-Content-SHA256', options.sha256);
    }

    const idle = new IdleTimeout(DEFAULT_FILES_IDLE_TIMEOUT, this.options.name ?? 'sandbox');
    idle.attach(options.signal);

    try {
      const { body, duplex } = await this.putBody(content, idle);
      const init: StreamedRequestInit = {
        method: 'PUT',
        headers,
        signal: idle.signal,
        body: body as BodyInit,
      };
      if (duplex) {
        init.duplex = duplex;
      }

      const response = await raceAbort(this.send(`/files?${params}`, init), idle.signal, () => idle.abortReason());

      if (!response.ok) {
        const text = await response.text();
        throw raiseForFilesStatus(response.status, text);
      }

      const reply = (await response.json()) as FilesPutReply;
      if (typeof reply?.sha256 !== 'string') {
        // A 200 without the digest would surface as a false corruption claim.
        throw new Error('malformed /files reply');
      }
      return reply;
    } catch (error) {
      throw idle.classify(error);
    } finally {
      idle.dispose();
    }
  }

  /**
   * Stream a file's bytes from GET /files (executor v0.0.24+), chunk by chunk.
   *
   * One non-retrying request: a broken stream is the fs layer's to resume.
   * The timeout bounds idle time between chunks (60 s); a stalled body fails
   * with a SandboxTimeoutError naming the bound.
   */
  async *filesRead(path: string, options: { signal?: AbortSignal } = {}): AsyncGenerator<Uint8Array, void, unknown> {
    const reply = await this.filesReadRange(path, options);
    yield* reply.stream;
  }

  /**
   * GET /files with the resume headers (executor v0.0.24+): Range and If-Range
   * pass through, the reply's status (200 whole vs 206 slice) and strong ETag
   * come back beside the body stream. One non-retrying request — resuming is
   * the fs layer's loop around this seam, bounded by the same 60 s idle clock.
   */
  async filesReadRange(
    path: string,
    options: { range?: string; ifRange?: string; signal?: AbortSignal } = {},
  ): Promise<FilesReadRangeReply> {
    const params = new URLSearchParams({ path });
    const headers = new Headers();
    if (options.range) {
      headers.set('Range', options.range);
    }
    if (options.ifRange) {
      headers.set('If-Range', options.ifRange);
    }

    const idle = new IdleTimeout(DEFAULT_FILES_IDLE_TIMEOUT, this.options.name ?? 'sandbox');
    idle.attach(options.signal);

    let response: Response;
    try {
      response = await raceAbort(
        this.send(`/files?${params}`, { method: 'GET', headers, signal: idle.signal }),
        idle.signal,
        () => idle.abortReason(),
      );
    } catch (error) {
      idle.dispose();
      throw idle.classify(error);
    }

    if (!response.ok) {
      idle.dispose();
      const text = await response.text();
      throw raiseForFilesStatus(response.status, text);
    }

    return {
      status: response.status,
      etag: response.headers.get('ETag') ?? undefined,
      stream: this.pumpFilesBody(response, idle),
    };
  }

  /** The body half of a streamed GET: idle-bounded reads, clock disarmed at
   * yield (a consumer's pause is not a stall), connection freed on early exit. */
  private async *pumpFilesBody(
    response: Response,
    idle: IdleTimeout,
  ): AsyncGenerator<Uint8Array, void, unknown> {
    const body = response.body;
    if (!body) {
      idle.dispose();
      return;
    }

    const reader = body.getReader();
    let completed = false;
    try {
      idle.touch(); // headers arrived: the idle window starts over
      for (;;) {
        const { done, value } = await raceAbort(reader.read(), idle.signal, () => idle.abortReason());
        if (done) {
          completed = true;
          return;
        }
        // The clock bounds pending reads, not the consumer's processing time:
        // suspended at yield no read is pending, like Python's suspended generator.
        idle.clear();
        yield value;
        idle.touch();
      }
    } catch (error) {
      throw idle.classify(error);
    } finally {
      idle.dispose();
      // A consumer that stops early must not hold the connection.
      if (!completed) {
        body.cancel().catch(() => {});
      }
    }
  }

  /**
   * Open a multipart upload session (executor v0.0.24+).
   *
   * A file too large for one request uploads as offset-addressed parts: the
   * executor truncates a temp file to `size` up front, so parts land in any
   * order, in parallel, and a retried part overwrites the same bytes. Sessions
   * live in memory — an executor restart or an idle hour loses them, and the
   * upload starts over. One attempt only: a blind retry would orphan a session
   * (Python parity: no 5xx retry on open; fetch cannot prove a network error
   * happened before the executor saw the request, so nothing is retried).
   */
  async filesUploadOpen(
    path: string,
    size: number,
    options: { mode?: string; sha256?: string; signal?: AbortSignal } = {},
  ): Promise<FilesUploadSession> {
    const body: Record<string, unknown> = { path, size };
    if (options.mode !== undefined) {
      body.mode = options.mode;
    }
    if (options.sha256) {
      body.sha256 = options.sha256;
    }
    return this.postNoRetry<FilesUploadSession>('/files/uploads', { method: 'POST', signal: options.signal }, body);
  }

  /**
   * Write one part at its offset (executor v0.0.24+).
   *
   * The content is bytes, never a consumed stream — replayable by contract —
   * so transient network errors and 5xx retry with backoff like the JSON
   * routes (a retried part overwrites the same bytes at the executor). A fired
   * timeout is never retried: the fs layer answers it by splitting the part.
   * The timeout bounds idle time (60 s), re-armed as the body's chunks move.
   */
  async filesUploadPart(
    uploadId: string,
    offset: number,
    content: Uint8Array,
    options: { sha256?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    const params = new URLSearchParams({ offset: String(offset) });
    const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
    if (options.sha256) {
      headers.set('X-Content-SHA256', options.sha256);
    }

    let backoff = DEFAULT_EXECUTOR_RETRY_DELAY_MS;

    for (let attempt = 0; ; attempt++) {
      const idle = new IdleTimeout(DEFAULT_FILES_IDLE_TIMEOUT, this.options.name ?? 'sandbox');
      idle.attach(options.signal);
      try {
        const init: StreamedRequestInit = {
          method: 'PUT',
          headers,
          signal: idle.signal,
          body: withIdleTouch(chunkedStream(content), idle) as BodyInit,
          duplex: 'half',
        };
        const response = await raceAbort(
          this.send(`/files/uploads/${uploadId}?${params}`, init),
          idle.signal,
          () => idle.abortReason(),
        );

        if (response.status >= 500 && attempt < DEFAULT_EXECUTOR_RETRIES) {
          // Free the connection before the retry and honor early aborts.
          if (response.body) {
            await response.body.cancel().catch(() => {});
          }
          await wait(backoff, options.signal);
          backoff *= 2;
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          throw raiseForFilesStatus(response.status, text);
        }
        return; // 204: the part landed at its offset
      } catch (error) {
        const classified = idle.classify(error);
        if (classified !== error) {
          throw classified; // a fired timeout is never retried — the fs layer splits
        }
        if (error instanceof SandboxError) {
          throw error; // taxonomy-mapped (4xx, exhausted 5xx): the executor answered
        }
        if (options.signal?.aborted) {
          throw error; // the caller's abort, raw
        }
        if (attempt >= DEFAULT_EXECUTOR_RETRIES) {
          throw new SandboxConnectionError(`Request to sandbox executor failed: ${String(error)}`, {
            cause: error,
          });
        }
        await wait(backoff, options.signal);
        backoff *= 2;
      } finally {
        idle.dispose();
      }
    }
  }

  /**
   * The ranges received so far (executor v0.0.24+): half-open [start, end)
   * spans, sorted and coalesced, so a live session can resume by sending what
   * is missing.
   */
  async filesUploadStatus(uploadId: string, options: { signal?: AbortSignal } = {}): Promise<FilesUploadStatus> {
    return this.post<FilesUploadStatus>(`/files/uploads/${uploadId}`, { method: 'GET', signal: options.signal });
  }

  /**
   * Check coverage and commit (executor v0.0.24+).
   *
   * A 409 carries the missing ranges in the error body — the session stays
   * live, so the caller can fill the gaps and complete again. One attempt
   * only: a blind retry would double-submit the commit (Python parity).
   */
  async filesUploadComplete(
    uploadId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<FilesUploadCompleteReply> {
    return this.postNoRetry<FilesUploadCompleteReply>(`/files/uploads/${uploadId}/complete`, {
      method: 'POST',
      signal: options.signal,
    });
  }

  /** Abort the session and remove its temp file (executor v0.0.24+). */
  async filesUploadAbort(uploadId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.post<void>(`/files/uploads/${uploadId}`, { method: 'DELETE', signal: options.signal });
  }

  /** One JSON attempt, deadline-armed, taxonomy-mapped: no retries at all.
   *
   * Open and complete must never run twice — the first creates executor state,
   * the second double-submits the commit — and fetch cannot prove a network
   * error happened before the executor saw the request, so nothing retries
   * (Python retries connect-time errors only; this is the safe side of that
   * line, the same judgment as filesPut).
   */
  private async postNoRetry<T = any>(path: string, init: RequestInit, body?: unknown): Promise<T> {
    const deadline = this.armRequestTimeout(init, DEFAULT_HTTP_TIMEOUT);
    try {
      const response = await this.send(path, { ...init, signal: deadline.signal }, body);
      return await this.parse<T>(response);
    } catch (error) {
      if (deadline.timedOut()) {
        throw new SandboxTimeoutError(
          this.options.name ?? 'sandbox',
          deadline.timeout,
          `Request timed out after ${deadline.timeout}s`,
        );
      }
      if (init.signal?.aborted) {
        throw error;
      }
      throw error instanceof SandboxError
        ? error
        : new SandboxConnectionError(`Request to sandbox executor failed: ${String(error)}`, { cause: error });
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Whether this sandbox's executor serves the streamed /files routes.
   *
   * Probes once per handle with a body-less GET /files/stat: the legacy
   * executor (pre-v0.0.24) has no such route and answers 404, the new one
   * answers 400 ("path is required"). The result is cached for the handle's
   * lifetime — and concurrent first calls share one in-flight probe — so
   * the legacy warning fires at most once. Never inferred from a failed
   * transfer: an early 404 on a large PUT can surface as a Cloudflare 502
   * on Nomad.
   */
  async hasFilesRoutes(): Promise<boolean> {
    if (this.filesRoutes !== undefined) {
      return this.filesRoutes;
    }

    this.filesRoutesProbe ??= this.probeFilesRoutes().finally(() => {
      // A raised probe (401, 429, ...) must not be remembered: the next call re-probes.
      if (this.filesRoutes === undefined) {
        this.filesRoutesProbe = undefined;
      }
    });
    return this.filesRoutesProbe;
  }

  private async probeFilesRoutes(): Promise<boolean> {
    try {
      await this.post('/files/stat', { method: 'GET' });
      this.filesRoutes = true;
    } catch (error) {
      if (!(error instanceof SandboxRequestError)) {
        throw error;
      }
      const verdict = probeVerdict(error.status_code);
      if (!verdict) {
        console.warn(LEGACY_FILES_WARNING);
      }
      this.filesRoutes = verdict;
    }

    return this.filesRoutes;
  }

  /** Normalize a PUT body: every body is a stream the socket pulls, and
   * each pull re-arms the idle window — a slow transfer that keeps moving
   * is never cut off, a stalled one aborts at the 60 s bound. */
  private async putBody(
    content: FilesPutContent,
    idle: IdleTimeout,
  ): Promise<{ body: unknown; duplex?: 'half' }> {
    if (typeof content === 'object' && content !== null && typeof (content as ReadableStream<Uint8Array>).getReader === 'function') {
      return { body: withIdleTouch(content as ReadableStream<Uint8Array>, idle), duplex: 'half' };
    }

    if (content instanceof Uint8Array) {
      return { body: withIdleTouch(chunkedStream(content), idle), duplex: 'half' };
    }

    // A Node stream: convert to the web stream fetch requires. The dynamic
    // import keeps non-Node runtimes loadable until a Node stream arrives.
    const { Readable } = await import('node:stream');
    const web = Readable.toWeb(content as NodeJS.ReadableStream as never) as unknown as ReadableStream<Uint8Array>;
    return { body: withIdleTouch(web, idle), duplex: 'half' };
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
