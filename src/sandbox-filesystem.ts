import {
  SandboxError,
  SandboxFileExistsError,
  SandboxFileNotFoundError,
  SandboxFilesystemError,
  SandboxRequestError,
  SandboxServiceError,
  SandboxTimeoutError,
} from './errors.js';
import type {
  FileStatEntry,
  FilesPutContent,
  FilesPutOptions,
  FilesPutReply,
  FilesReadRangeReply,
  FilesUploadCompleteReply,
  FilesUploadSession,
  FilesUploadStatus,
} from './executor-gateway.js';
import {
  DEFAULT_EXECUTOR_RETRY_DELAY_MS,
  DOWNLOAD_STALLED_RETRIES,
  FILES_PROGRESS_INTERVAL_MS,
  UPLOAD_CONCURRENCY,
  UPLOAD_PART_SIZE,
} from './constants.js';
import { wait } from './time.js';
import { shellQuote } from './shell.js';
import type { FileHandle } from 'node:fs/promises';

/**
 * Filesystem operations for Koyeb Sandbox instances.
 *
 * On executors v0.0.24+ the byte-moving operations run on the streamed
 * /files routes: binary-safe, constant memory, real bytes on disk. Older
 * executors are detected once per handle (a body-less GET /files/stat
 * probe) and keep the legacy JSON routes; there, bytes ride the base64
 * transport so transfers stay binary-safe, round-tripping byte-exact
 * through this SDK.
 */

/** What write_file accepts: text, bytes, or a stream of either's bytes. */
export type FileContent = string | Uint8Array | Blob | ReadableStream<Uint8Array> | NodeJS.ReadableStream;

export type WriteFileOptions = {
  /** Octal permission string, e.g. '0644' (streamed routes only; the legacy routes keep the destination's mode). */
  mode?: string;
  /** Cancels an in-flight transfer; nothing partial is left behind. */
  signal?: AbortSignal;
};

/** 'utf-8' → string; 'base64' → base64 of the real bytes; null → raw Uint8Array. */
export type ReadFileEncoding = 'utf-8' | 'base64' | null;

export type ReadFileOptions = { encoding?: ReadFileEncoding };

export type TransferProgress = (done: number, total: number) => void;

export type TransferOptions = {
  /** Called at most every 100 ms during the transfer, plus a final call (streamed routes only). */
  progress?: TransferProgress;
  /** Cancels an in-flight transfer; nothing partial is left behind. Legacy
   * downloads read the whole file in one request — there the signal is
   * checked at entry, not mid-flight. */
  signal?: AbortSignal;
  /**
   * Legacy executors only (the streamed routes are binary-safe and ignore
   * it): the transport of the transfer. 'utf-8' (the default) keeps the
   * historical text behavior; 'base64' rides the base64 transport, so
   * binary files round-trip byte-exact through this SDK on any executor.
   */
  encoding?: 'utf-8' | 'base64';
};

/** File metadata from the streamed /files/stat route (executor v0.0.24+).
 *
 * type is one of file|dir|symlink|other; mode is the octal permission string
 * (e.g. '0644'); mtime is RFC 3339 UTC with nanoseconds.
 */
export type FileStat = {
  type: string;
  size: number;
  mode: string;
  mtime: string;
  sha256?: string;
};

/** The executor calls the filesystem layer needs; Sandbox satisfies it structurally. */
export type SandboxPort = {
  exec: (cmd: string, options?: { cwd?: string; env?: Record<string, string> }) => Promise<{ stdout: string; stderr: string; code: number }>;
  request: (path: string, init: RequestInit, body?: unknown) => Promise<any>;
  hasFilesRoutes: () => Promise<boolean>;
  filesStat: (path: string) => Promise<FileStatEntry>;
  filesPut: (path: string, content: FilesPutContent, options?: FilesPutOptions) => Promise<FilesPutReply>;
  filesRead: (path: string, options?: { signal?: AbortSignal }) => AsyncGenerator<Uint8Array, void, unknown>;
  filesReadRange: (
    path: string,
    options?: { range?: string; ifRange?: string; signal?: AbortSignal },
  ) => Promise<FilesReadRangeReply>;
  filesUploadOpen: (
    path: string,
    size: number,
    options?: { mode?: string; sha256?: string; signal?: AbortSignal },
  ) => Promise<FilesUploadSession>;
  filesUploadPart: (
    uploadId: string,
    offset: number,
    content: Uint8Array,
    options?: { sha256?: string; signal?: AbortSignal },
  ) => Promise<void>;
  filesUploadStatus: (uploadId: string, options?: { signal?: AbortSignal }) => Promise<FilesUploadStatus>;
  filesUploadComplete: (uploadId: string, options?: { signal?: AbortSignal }) => Promise<FilesUploadCompleteReply>;
  filesUploadAbort: (uploadId: string, options?: { signal?: AbortSignal }) => Promise<void>;
};

// Multipart uploads: a part that times out is split in half rather than
// failed — a smaller part needs less time on the wire. Below twice this floor
// a split cannot help: the connection is stalling, not slow (Python parity).
const MIN_SPLIT_SIZE = 1024 * 1024;

// The executor's sessions live in memory: a restart or the 1 h idle expiry
// loses them, and a 404 from a part or complete means starting over.
const LOST_SESSION_MESSAGE =
  'Upload session was lost — the executor restarted or the session expired; restart the upload';

/** (offset, length) parts covering [start, end) in partSize slices. */
function partPlan(start: number, end: number, partSize: number): Array<[number, number]> {
  const plan: Array<[number, number]> = [];
  for (let offset = start; offset < end; offset += partSize) {
    plan.push([offset, Math.min(partSize, end - offset)]);
  }
  return plan;
}

/** A part's bytes and digest, read from disk at its offset.
 *
 * Read per attempt — no part bytes are buffered between retries, so memory
 * holds at most one part per worker (Python parity: _read_part_with_digest).
 */
async function readPartWithDigest(path: string, offset: number, length: number): Promise<{ data: Uint8Array; digest: string }> {
  const { open } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const data = read === length ? buffer : buffer.subarray(0, read);
    return { data, digest: createHash('sha256').update(data).digest('hex') };
  } finally {
    await handle.close();
  }
}

/** The complete-409 body's missing spans, as [start, end) tuples.
 *
 * null means the body carried no usable ranges: the resume signal is absent
 * and the failure is the caller's to report. The body arrives parsed (the
 * JSON routes) or as text — both are read.
 */
function missingRangesFrom409(body: unknown): Array<[number, number]> | null {
  const source = typeof body === 'string' ? tryJsonParse(body) : body;
  const ranges = (source as { ranges?: unknown } | null)?.ranges;
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const spans: Array<[number, number]> = [];
  for (const range of ranges) {
    const { start, end } = range as { start?: unknown; end?: unknown };
    if (typeof start !== 'number' || !Number.isInteger(start)) return null;
    if (typeof end !== 'number' || !Number.isInteger(end)) return null;
    if (start < 0 || end <= start) return null;
    spans.push([start, end]);
  }
  return spans;
}

/** Whether a failed part should be retried as smaller halves.
 *
 * The transport already retries transient network errors; what it never
 * retries is a fired timeout — the idle bound (SandboxTimeoutError) or
 * Cloudflare's origin cap (524, surfaced as SandboxServiceError after the
 * transport's own retries). Those are the fs layer's to split: a smaller
 * part needs less time on the wire.
 */
function splitWorthy(error: unknown): boolean {
  if (error instanceof SandboxTimeoutError) return true;
  return error instanceof SandboxServiceError && error.status_code === 524;
}

/** Byte counter across concurrent parts: progress(done, total) as they land. */
class PartProgress {
  private done = 0;

  constructor(
    private readonly reporter: ProgressReporter,
    private readonly total: number,
  ) {}

  add(bytes: number): void {
    // A 409-fill re-sends already-counted bytes; done never passes the file size.
    this.done = Math.min(this.done + bytes, this.total);
    this.reporter.update(this.done);
  }

  finish(): void {
    this.reporter.finish(this.done);
  }
}

// The executor reports failures as raw Go error strings ("no such file or
// directory"); classify them with the Python SDK's human-phrase patterns.
const NOT_FOUND_PATTERNS = ['no such file', 'not found'];
const EXISTS_PATTERNS = ['exists', 'already exists'];

function matchesPatterns(error: string, patterns: string[]): boolean {
  const lower = error.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

/**
 * The sandbox executor reports failures as a 200 response carrying an
 * `error` field; classify them into the SDK error hierarchy like the
 * Python SDK does (NO_SUCH_FILE / FILE_EXISTS pattern matching).
 */
function checkExecutorError(
  response: { error?: unknown },
  path: string,
  what: string,
  kinds: readonly ('not_found' | 'exists')[],
): void {
  const error = response?.error;

  if (typeof error !== 'string' || error.length === 0) {
    return;
  }

  if (kinds.includes('not_found') && matchesPatterns(error, NOT_FOUND_PATTERNS)) {
    throw new SandboxFileNotFoundError(`${what} failed: ${error} (path: ${path})`);
  }
  if (kinds.includes('exists') && matchesPatterns(error, EXISTS_PATTERNS)) {
    throw new SandboxFileExistsError(`${what} failed: ${error} (path: ${path})`);
  }

  throw new SandboxFilesystemError(`${what} failed: ${error} (path: ${path})`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Decode base64, refusing garbage: a wrong read must fail, not corrupt. */
function base64Decode(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('Invalid base64-encoded string');
  }
  return new Uint8Array(Buffer.from(compact, 'base64'));
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The `error` text of a streamed-route error body, string or parsed JSON. */
function errorText(body: unknown): string {
  // String bodies are the streamed routes' raw text (JSON or not); object
  // bodies are what the JSON routes' parse() hands through.
  const source: unknown =
    typeof body === 'string' ? tryJsonParse(body) : body !== null && typeof body === 'object' ? body : null;
  return typeof (source as { error?: unknown } | null)?.error === 'string'
    ? (source as { error: string }).error
    : '';
}

function tryJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** An error body as the message should quote it: text stays text, objects stringify. */
function formatErrorBody(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/**
 * A streamed-route status error classified into the filesystem taxonomy.
 * The /files routes answer with real status codes: the code is the contract,
 * the JSON body's error text only adds detail.
 */
function filesError(error: SandboxRequestError, what: string, path: string): SandboxFilesystemError {
  const message = errorText(error.body);

  if (error.status_code === 404) {
    return new SandboxFileNotFoundError(`File not found: ${path}`);
  }
  if (error.status_code === 409) {
    return new SandboxFileExistsError(message || `Conflict at: ${path}`);
  }

  const detail =
    message ||
    (typeof error.body === 'string' && error.body
      ? error.body
      : error.body !== undefined && error.body !== null && error.body !== ''
        ? JSON.stringify(error.body)
        : `HTTP ${error.status_code}`);
  return new SandboxFilesystemError(`Failed to ${what}: ${detail}`);
}

/**
 * The streamed-route error policy: status errors classify through
 * filesError, service/filesystem errors and caller aborts pass through
 * as-is, anything else wraps as "Failed to <what>". Always throws.
 */
function translateFilesError(error: unknown, what: string, path: string): SandboxFilesystemError {
  if (error instanceof SandboxServiceError) throw error;
  if (error instanceof SandboxRequestError) throw filesError(error, what, path);
  if (error instanceof SandboxFilesystemError) throw error;
  if (isAbort(error)) throw error;
  return new SandboxFilesystemError(`Failed to ${what}: ${errorMessage(error)}`);
}

/**
 * Translate streamed-route failures once, for every filesystem operation:
 * one policy, every operation — the filesystem taxonomy is what callers catch.
 */
async function translatingFilesErrors<T>(what: string, path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw translateFilesError(error, what, path);
  }
}

/**
 * The legacy routes' error policy: classified errors pass, the rest wrap.
 * Not-found and exists messages (Python's not_found_msg=/exists_msg=...)
 * classify when the operation can produce them. Always throws.
 */
function translateLegacyError(
  error: unknown,
  what: string,
  notFoundMessage?: string,
  existsMessage?: string,
): SandboxFilesystemError {
  if (error instanceof SandboxServiceError || error instanceof SandboxFilesystemError) throw error;
  const message = errorMessage(error);
  if (notFoundMessage !== undefined && matchesPatterns(message, NOT_FOUND_PATTERNS)) {
    throw new SandboxFileNotFoundError(notFoundMessage);
  }
  if (existsMessage !== undefined && matchesPatterns(message, EXISTS_PATTERNS)) {
    throw new SandboxFileExistsError(existsMessage);
  }
  return new SandboxFilesystemError(`Failed to ${what}: ${message}`);
}

/** A caller-driven abort surfaces raw, like every other abort in this SDK. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** progress(done, total) at most every FILES_PROGRESS_INTERVAL_MS, plus a guaranteed final call. */
export class ProgressReporter {
  // -Infinity: the first update always fires — performance.now() starts at
  // process birth, so 0 would suppress progress in the first 100 ms.
  private lastTime = Number.NEGATIVE_INFINITY;
  private lastDone: number | undefined;

  constructor(
    private readonly progress: TransferProgress | undefined,
    private readonly total: number,
  ) {}

  update(done: number): void {
    if (!this.progress) return;
    // Monotonic, like Python's time.monotonic(): a wall-clock step must not
    // suppress or flood progress callbacks.
    const now = performance.now();
    if (now - this.lastTime >= FILES_PROGRESS_INTERVAL_MS) {
      this.progress(done, this.total);
      this.lastTime = now;
      this.lastDone = done;
    }
  }

  finish(done: number): void {
    if (this.progress && done !== this.lastDone) {
      this.progress(done, this.total);
    }
  }
}

/** sha256 of a local file, constant memory: a first pass before the streamed upload. */
async function fileSha256(localPath: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(localPath, { highWaterMark: 1 << 20 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** What the streamed PUT receives: bytes for text and buffers, streams for streams and Blobs. */
function toPutContent(content: FileContent): FilesPutContent {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof Blob) {
    return content.stream() as ReadableStream<Uint8Array>;
  }
  return content;
}

/** A stat entry shaped like the contract, or a fail-fast error. */
function requireStatEntry(entry: FileStatEntry): FileStatEntry {
  if (
    typeof entry?.type !== 'string' ||
    typeof entry?.size !== 'number' ||
    typeof entry?.mode !== 'string' ||
    typeof entry?.mtime !== 'string'
  ) {
    throw new Error('malformed /files/stat reply');
  }
  return entry;
}

export class SandboxFilesystem {
  constructor(private readonly sandbox: SandboxPort) {}

  async mkdir(path: string, recursive = false): Promise<void> {
    try {
      checkExecutorError(
        await this.sandbox.request('/make_dir', { method: 'POST' }, { path, recursive }),
        path,
        'mkdir',
        ['exists'],
      );
    } catch (error) {
      throw translateLegacyError(error, 'create directory', undefined, `Directory already exists: ${path}`);
    }
  }

  /** Python parity: the short spelling of list_dir. */
  ls(path = '.'): Promise<string[]> {
    return this.list_dir(path);
  }

  async list_dir(path = '.'): Promise<string[]> {
    try {
      const result = await this.sandbox.request('/list_dir', { method: 'POST' }, { path });
      checkExecutorError(result, path, 'list_dir', ['not_found']);
      return result.entries ?? [];
    } catch (error) {
      throw translateLegacyError(error, 'list directory', `Directory not found: ${path}`);
    }
  }

  async delete_dir(path: string): Promise<void> {
    try {
      checkExecutorError(
        await this.sandbox.request('/delete_dir', { method: 'POST' }, { path }),
        path,
        'delete_dir',
        ['not_found'],
      );
    } catch (error) {
      throw translateLegacyError(error, 'delete directory', `Directory not found: ${path}`);
    }
  }

  /**
   * Write content to a file.
   *
   * On executors v0.0.24+ the content streams through PUT /files,
   * binary-safe: any byte sequence lands on disk as-is, whatever the content
   * type. Older executors keep the legacy JSON behavior: text writes as-is,
   * Uint8Array rides the base64 transport (byte-exact round-trips through
   * this SDK), and streams cannot be carried — they raise and name v0.0.24.
   */
  async write_file(path: string, content: FileContent, options: WriteFileOptions = {}): Promise<void> {
    if (await this.sandbox.hasFilesRoutes()) {
      await translatingFilesErrors('write file', path, () =>
        this.sandbox.filesPut(path, toPutContent(content), { mode: options.mode, signal: options.signal }),
      );
      return;
    }

    if (typeof content === 'string' || content instanceof Uint8Array) {
      try {
        const body = typeof content === 'string' ? content : base64Encode(content);
        const response = await this.sandbox.request(
          '/write_file',
          { method: 'POST', signal: options.signal },
          { path, content: body },
        );
        checkExecutorError(response, path, 'write_file', []);
      } catch (error) {
        throw translateLegacyError(error, 'write file');
      }
      return;
    }

    throw new SandboxFilesystemError(
      'streamed content (a Blob or a stream) requires the streamed /files routes (executor v0.0.24+)',
    );
  }

  async write_files(files: Array<{ path: string; content: string }>): Promise<void> {
    await Promise.all(files.map(({ path, content }) => this.write_file(path, content)));
  }

  /**
   * Read a file from the sandbox.
   *
   * On executors v0.0.24+ the bytes stream from GET /files, binary-safe:
   * `{ encoding: null }` returns the disk bytes as a Uint8Array, and
   * `{ encoding: 'base64' }` encodes the real bytes for transport. Older
   * executors keep the legacy JSON behavior: 'utf-8' returns the content
   * text, 'base64' decodes the file's base64 text into bytes, and null
   * raises and names v0.0.24.
   *
   * @returns the content: a string for 'utf-8' and streamed 'base64', a Uint8Array
   *          for null and legacy 'base64'.
   */
  async read_file(path: string, options: ReadFileOptions = {}): Promise<string | Uint8Array> {
    // `null` is an explicit "raw bytes" request; only an absent option defaults to utf-8.
    const encoding = options.encoding === undefined ? ('utf-8' as const) : options.encoding;

    if (await this.sandbox.hasFilesRoutes()) {
      return translatingFilesErrors('read file', path, async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of this.sandbox.filesRead(path)) {
          chunks.push(chunk);
        }
        return readContent(concatBytes(chunks), encoding);
      });
    }

    if (encoding === null) {
      throw new SandboxFilesystemError(
        'reading raw bytes (encoding=null) requires the streamed /files routes (executor v0.0.24+)',
      );
    }

    try {
      const response = await this.sandbox.request('/read_file', { method: 'POST' }, { path });
      checkExecutorError(response, path, 'read_file', ['not_found']);
      if (typeof response?.content !== 'string') {
        throw new SandboxFilesystemError('malformed /read_file reply');
      }
      return encoding === 'base64' ? base64Decode(response.content) : response.content;
    } catch (error) {
      throw translateLegacyError(error, 'read file', `File not found: ${path}`);
    }
  }

  /**
   * Stream a file's bytes from the sandbox, chunk by chunk.
   *
   * Constant memory on both sides (executor v0.0.24+). On legacy executors
   * the file is read once as text and yielded as a single chunk —
   * binary-safe streaming is not available there.
   */
  async *read_stream(path: string): AsyncGenerator<Uint8Array, void, unknown> {
    if (!(await this.sandbox.hasFilesRoutes())) {
      const content = await this.read_file(path);
      yield new TextEncoder().encode(content as string);
      return;
    }

    try {
      for await (const chunk of this.sandbox.filesRead(path)) {
        yield chunk;
      }
    } catch (error) {
      throw translateFilesError(error, 'read file', path);
    }
  }

  /**
   * Stat a file on the sandbox (executor v0.0.24+).
   *
   * Legacy executors have no stat route: this raises. Size comes from the
   * filesystem, never from a HEAD — size-0 pseudo-files (e.g. under /proc)
   * carry no length but have content.
   */
  async stat(path: string): Promise<FileStat> {
    if (!(await this.sandbox.hasFilesRoutes())) {
      throw new SandboxFilesystemError('stat requires the streamed /files routes (executor v0.0.24+)');
    }

    return translatingFilesErrors('stat file', path, async () => {
      const entry = requireStatEntry(await this.sandbox.filesStat(path));
      const stat: FileStat = { type: entry.type, size: entry.size, mode: entry.mode, mtime: entry.mtime };
      if (entry.sha256 !== undefined) {
        stat.sha256 = entry.sha256;
      }
      return stat;
    });
  }

  async rename_file(old_path: string, new_path: string): Promise<void> {
    await this.move_file(old_path, new_path);
  }

  /** No dedicated executor endpoint for moves: shell `mv` with quoting, like `rm`. */
  async move_file(source_path: string, destination_path: string): Promise<void> {
    const result = await this.sandbox.exec(`mv ${shellQuote(source_path)} ${shellQuote(destination_path)}`);

    if (result.code !== 0) {
      if (matchesPatterns(result.stderr, NOT_FOUND_PATTERNS)) {
        throw new SandboxFileNotFoundError(`move_file failed: ${result.stderr} (path: ${source_path})`);
      }
      throw new SandboxFilesystemError(`move_file failed: ${result.stderr} (path: ${source_path})`);
    }
  }

  async delete_file(path: string): Promise<void> {
    try {
      checkExecutorError(
        await this.sandbox.request('/delete_file', { method: 'POST' }, { path }),
        path,
        'delete_file',
        ['not_found'],
      );
    } catch (error) {
      throw translateLegacyError(error, 'delete file', `File not found: ${path}`);
    }
  }

  async rm(path: string, recursive = false): Promise<void> {
    const result = await this.sandbox.exec(`rm ${recursive ? '-rf ' : ''}${shellQuote(path)}`);

    if (result.code !== 0) {
      if (matchesPatterns(result.stderr, NOT_FOUND_PATTERNS)) {
        throw new SandboxFileNotFoundError(`File not found: ${path}`);
      }
      throw new SandboxFilesystemError(`Failed to remove: ${result.stderr}`);
    }
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.sandbox.exec(`test -e ${shellQuote(path)}`);
    return result.code === 0;
  }

  async is_file(path: string): Promise<boolean> {
    const result = await this.sandbox.exec(`test -f ${shellQuote(path)}`);
    return result.code === 0;
  }

  async is_dir(path: string): Promise<boolean> {
    const result = await this.sandbox.exec(`test -d ${shellQuote(path)}`);
    return result.code === 0;
  }

  /**
   * Upload a local file to the sandbox.
   *
   * On executors v0.0.24+ the file streams from disk through PUT /files —
   * binary-safe, constant memory — with its sha256 in X-Content-SHA256,
   * cross-checked against the executor's reply. A file larger than
   * part_size uploads as a multipart session: up to `concurrency` parts in
   * flight, each read from disk at its offset, per-part sha256, timed-out
   * parts split into halves, and a complete that reports missing ranges
   * fills them and completes again. Older executors keep the legacy JSON
   * routes with the base64 transport (see TransferOptions.encoding).
   *
   * The transfer is bounded by a 60 s idle timeout only; a slow transfer
   * that keeps moving is never cut off.
   *
   * @throws SandboxFileNotFoundError if the local file doesn't exist.
   */
  async upload_file(
    local_path: string,
    remote_path: string,
    options: TransferOptions & { part_size?: number; concurrency?: number } = {},
  ): Promise<void> {
    const fs = await import('node:fs/promises');

    let total: number;
    try {
      total = (await fs.stat(local_path)).size;
    } catch {
      throw new SandboxFileNotFoundError(`Local file not found: ${local_path}`);
    }

    if (!(await this.sandbox.hasFilesRoutes())) {
      const bytes = new Uint8Array(await fs.readFile(local_path));
      if (options.encoding === 'base64') {
        await this.write_file(remote_path, bytes, { signal: options.signal });
        return;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new SandboxFilesystemError(
          `Local file is not valid UTF-8: ${local_path} — pass { encoding: 'base64' } for a binary ` +
            'transfer on this legacy executor (pre-v0.0.24), or write Uint8Array content directly',
        );
      }
      await this.write_file(remote_path, text, { signal: options.signal });
      return;
    }

    const partSize = options.part_size ?? UPLOAD_PART_SIZE;
    const concurrency = options.concurrency ?? UPLOAD_CONCURRENCY;
    if (partSize <= 0 || concurrency <= 0) {
      throw new SandboxFilesystemError('part_size and concurrency must be positive');
    }

    await translatingFilesErrors('upload file', remote_path, async () => {
      // A first constant-memory pass: the digest travels in the open payload
      // for multipart (checked once at complete) or in X-Content-SHA256 for
      // the single PUT, which precedes the body on the wire.
      const digest = await fileSha256(local_path);

      if (total > partSize) {
        await this.uploadMultipart(
          local_path,
          remote_path,
          total,
          digest,
          partSize,
          concurrency,
          options.signal,
          new ProgressReporter(options.progress, total),
        );
        return;
      }

      const reporter = new ProgressReporter(options.progress, total);
      const { createReadStream } = await import('node:fs');
      const { Readable } = await import('node:stream');
      let done = 0;
      const body = (
        Readable.toWeb(createReadStream(local_path)) as unknown as ReadableStream<Uint8Array>
      ).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            done += chunk.byteLength;
            reporter.update(done);
            controller.enqueue(chunk);
          },
          flush() {
            reporter.finish(done);
          },
        }),
      );

      const reply = await this.sandbox.filesPut(remote_path, body, { sha256: digest, signal: options.signal });

      if (reply.sha256 !== digest) {
        throw new SandboxFilesystemError(
          `Upload corrupted in transit: executor sha256 ${reply.sha256} != ${digest}`,
        );
      }

      return reply;
    });
  }

  /** The session flow: open, parts, complete — abort on any failure.
   *
   * Sessions live at the executor: a lost one (restart, idle expiry) cannot
   * be resumed, only restarted (Python parity: _upload_multipart).
   */
  private async uploadMultipart(
    local_path: string,
    remote_path: string,
    size: number,
    digest: string,
    partSize: number,
    concurrency: number,
    signal: AbortSignal | undefined,
    reporter: ProgressReporter,
  ): Promise<void> {
    const session = await this.sandbox.filesUploadOpen(remote_path, size, { sha256: digest, signal });
    const uploadId = session?.upload_id;
    if (typeof uploadId !== 'string' || uploadId.length === 0) {
      throw new SandboxFilesystemError(`Upload session reply missing upload_id: ${JSON.stringify(session)}`);
    }

    const counter = new PartProgress(reporter, size);
    try {
      // A valid id means the session lives at the executor; every failure
      // from here on must abort it.
      const cap = session?.max_part_size;
      if (typeof cap !== 'number' || cap < 1) {
        throw new SandboxFilesystemError(`Upload session reply missing max_part_size: ${JSON.stringify(session)}`);
      }
      const effective = Math.min(partSize, cap);
      await this.putParts(local_path, uploadId, [[0, size]], effective, concurrency, signal, counter);
      const reply = await this.completeFillingGaps(local_path, uploadId, effective, concurrency, signal, counter);
      // The contract marks complete's sha256 optional: a 200 has already
      // matched the open-payload digest at the executor.
      const got = reply?.sha256;
      if (got !== undefined && got !== digest) {
        throw new SandboxFilesystemError(
          `Upload corrupted in transit: executor sha256 ${got} != ${digest}`,
        );
      }
    } catch (error) {
      try {
        // The abort is the SDK's own cleanup: it fires without the caller's
        // signal, which is likely already aborted and would strand the
        // executor's temp file (the request stays bounded by its own cap).
        await this.sandbox.filesUploadAbort(uploadId);
      } catch {
        // The abort's own failures never mask the failure that caused it
        // (Python parity: swallowed unconditionally — a raw error from the
        // cleanup must not replace the cause either).
      }
      throw error;
    }
    counter.finish();
  }

  /** PUT the given ranges as parts, `concurrency` in flight, fail fast.
   *
   * Workers pull from a shared plan; the first failure stops the pool —
   * the remaining parts are never sent (Python parity: _put_parts).
   */
  private async putParts(
    local_path: string,
    uploadId: string,
    ranges: Array<[number, number]>,
    partSize: number,
    concurrency: number,
    signal: AbortSignal | undefined,
    counter: PartProgress,
  ): Promise<void> {
    const plan: Array<[number, number]> = [];
    for (const [start, end] of ranges) {
      plan.push(...partPlan(start, end, partSize));
    }
    if (plan.length === 0) return;

    let next = 0;
    let stopped = false;
    let firstError: { error: unknown } | undefined;

    const worker = async (): Promise<void> => {
      while (!stopped) {
        const index = next;
        next += 1;
        if (index >= plan.length) return;
        const [offset, length] = plan[index];
        try {
          await this.putOnePart(local_path, uploadId, offset, length, signal, counter);
        } catch (error) {
          // The stored interrupt must stop the remaining parts now, not
          // after the plan drains.
          stopped = true;
          if (firstError === undefined) firstError = { error };
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
    if (firstError !== undefined) throw firstError.error;
  }

  /** PUT one range; a timed-out part splits into halves and retries
   *  (Python parity: _put_one_part — the halves go first-half-first). */
  private async putOnePart(
    local_path: string,
    uploadId: string,
    offset: number,
    length: number,
    signal: AbortSignal | undefined,
    counter: PartProgress,
  ): Promise<void> {
    const pending: Array<[number, number]> = [[offset, length]];
    while (pending.length > 0) {
      const [off, ln] = pending.pop()!;
      const { data, digest } = await readPartWithDigest(local_path, off, ln);
      try {
        await this.sandbox.filesUploadPart(uploadId, off, data, { sha256: digest, signal });
      } catch (error) {
        // Split-worthy first: a 524 arrives as SandboxServiceError, a
        // subclass of SandboxRequestError.
        if (splitWorthy(error) && ln >= 2 * MIN_SPLIT_SIZE) {
          const half = Math.floor(ln / 2);
          pending.push([off + half, ln - half]);
          pending.push([off, half]);
          continue;
        }
        if (error instanceof SandboxRequestError && error.status_code === 404) {
          throw new SandboxFilesystemError(LOST_SESSION_MESSAGE, { cause: error });
        }
        throw error;
      }
      counter.add(ln);
    }
  }

  /** Complete; a 409's missing ranges are filled and complete retried.
   *
   * The session stays live across a 409 — it is the resume signal. Every
   * fill must shrink the missing bytes; one that does not is the executor
   * not recording the fills, and that loop is cut here rather than spun
   * forever (Python parity: _complete_filling_gaps).
   */
  private async completeFillingGaps(
    local_path: string,
    uploadId: string,
    partSize: number,
    concurrency: number,
    signal: AbortSignal | undefined,
    counter: PartProgress,
  ): Promise<FilesUploadCompleteReply> {
    let previous: number | undefined;
    for (;;) {
      try {
        return await this.sandbox.filesUploadComplete(uploadId, { signal });
      } catch (error) {
        if (error instanceof SandboxRequestError && error.status_code === 404) {
          throw new SandboxFilesystemError(LOST_SESSION_MESSAGE, { cause: error });
        }
        if (!(error instanceof SandboxRequestError) || error.status_code !== 409) throw error;
        const missing = missingRangesFrom409(error.body);
        if (missing === null) {
          throw new SandboxFilesystemError(
            `Upload incomplete and the missing-ranges reply was unusable: ${formatErrorBody(error.body)}`,
            { cause: error },
          );
        }
        const missingBytes = missing.reduce((bytes, [start, end]) => bytes + (end - start), 0);
        if (previous !== undefined && missingBytes >= previous) {
          throw new SandboxFilesystemError(
            `Upload made no progress filling missing ranges: ${JSON.stringify(missing)}`,
            { cause: error },
          );
        }
        previous = missingBytes;
        await this.putParts(local_path, uploadId, missing, partSize, concurrency, signal, counter);
      }
    }
  }

  /**
   * Download a file from the sandbox to a local path.
   *
   * On executors v0.0.24+ the size comes from stat (never a HEAD), the bytes
   * stream into `<local>.part` and rename into place on success: a failed
   * download leaves the destination exactly as it was. Resume is on by
   * default: after a network error the remaining bytes are fetched with
   * `Range` + `If-Range` on the executor's strong ETag, so received bytes are
   * never re-sent; a file that changed under us restarts from scratch. Older
   * executors keep the legacy JSON routes with the base64 transport.
   *
   * The transfer is bounded by a 60 s idle timeout only; a slow transfer
   * that keeps moving is never cut off.
   *
   * @throws SandboxFileNotFoundError if the remote file doesn't exist.
   */
  async download_file(remote_path: string, local_path: string, options: TransferOptions = {}): Promise<void> {
    const fs = await import('node:fs/promises');

    // The legacy arm reads the whole file in one request; honor the signal
    // at entry so an aborted transfer never touches the disk.
    options.signal?.throwIfAborted();

    if (!(await this.sandbox.hasFilesRoutes())) {
      const content = await this.read_file(remote_path, { encoding: options.encoding ?? 'utf-8' });
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      await fs.writeFile(local_path, bytes);
      return;
    }

    const part_path = `${local_path}.part`;
    let renamed = false;
    try {
      await translatingFilesErrors('download file', remote_path, async () => {
        const entry = requireStatEntry(await this.sandbox.filesStat(remote_path));
        const reporter = new ProgressReporter(options.progress, entry.size);

        const handle = await fs.open(part_path, 'w');
        let done: number;
        try {
          done = await this.streamWithResume(remote_path, entry.size, handle, reporter, options.signal);
        } finally {
          await handle.close();
        }
        reporter.finish(done);

        await fs.rename(part_path, local_path);
        renamed = true;
      });
    } finally {
      if (!renamed) {
        await fs.rm(part_path, { force: true }).catch(() => {});
      }
    }
  }

  /** Stream the bytes into `handle`, resuming after a failure.
   *
   * One attempt is one ranged GET. Bytes land at their offset (position =
   * done), so a resume appends exactly where the last attempt stopped. The
   * strong ETag is the resume validator: an If-Range match yields a 206 slice,
   * a miss (the file changed) a 200 whole body — the part file restarts from
   * scratch. Files without a validator (size-0 pseudo-files) cannot resume:
   * their failures also restart from scratch, never doubling bytes. A 4xx is
   * the executor answering — it surfaces; attempts that land no bytes back
   * off and retry up to DOWNLOAD_STALLED_RETRIES times, the transport's own
   * budget; a landing attempt resets it, so a moving transfer keeps going.
   * A file without a validator cannot keep what landed — its restarts
   * discard the bytes, so they count against the budget too: a stream that
   * keeps dying mid-body surfaces instead of looping forever.
   */
  private async streamWithResume(
    remote_path: string,
    total: number,
    handle: FileHandle,
    reporter: ProgressReporter,
    signal?: AbortSignal,
  ): Promise<number> {
    let done = 0;
    let etag: string | undefined;
    let stalled = 0;
    let backoff = DEFAULT_EXECUTOR_RETRY_DELAY_MS;

    const restartFromScratch = async () => {
      await handle.truncate(0);
      done = 0;
    };

    for (;;) {
      let start = done;
      const resumable = done > 0 && etag !== undefined;
      let failed: unknown;
      let ended = false;

      try {
        const reply = await this.sandbox.filesReadRange(
          remote_path,
          {
            ...(resumable ? { range: `bytes=${done}-`, ifRange: etag } : {}),
            signal,
          },
        );
        if (reply.status === 200 && resumable) {
          // If-Range missed: the file changed under us — start over. The
          // restart discards the resume base, so the budget measures this
          // attempt from zero: one that lands nothing under the fresh body
          // spends it, never a phantom progress reset.
          await restartFromScratch();
          start = done;
        }
        if (reply.status !== 206) {
          etag = reply.etag; // the fresh validator; a 206 keeps the matched one
        }
        for await (const chunk of reply.stream) {
          // Position-pinned writes: a resume appends where the bytes stopped,
          // and a truncate-then-restart leaves no hole.
          await handle.write(chunk, 0, chunk.byteLength, done);
          done += chunk.byteLength;
          reporter.update(done);
        }
        ended = true;
      } catch (error) {
        if (isAbort(error)) throw error;
        if (error instanceof SandboxRequestError && !(error instanceof SandboxServiceError)) {
          throw error; // 4xx: the executor answered; a retry cannot change it
        }
        failed = error;
      }

      if (ended && (total === 0 || done >= total)) return done;

      // The attempt failed or ended short — resume by what landed. A file
      // without a validator cannot keep its bytes: the restart discards
      // them, so the attempt made no net progress and spends the budget
      // like a landed-nothing one — or a dying stream loops forever, always
      // "progressing" and never surfacing.
      const discards = done > 0 && etag === undefined;
      if (discards) {
        await restartFromScratch();
      }
      if (done === start || discards) {
        stalled += 1;
        if (stalled > DOWNLOAD_STALLED_RETRIES) {
          throw (
            failed ?? new SandboxFilesystemError('Download made no progress: the stream keeps ending short')
          );
        }
        await wait(backoff, signal);
        backoff *= 2;
        continue;
      }

      // Bytes landed and are kept: progress resets the budget.
      stalled = 0;
      backoff = DEFAULT_EXECUTOR_RETRY_DELAY_MS;
    }
  }
}

/** Interpret raw file bytes per the requested encoding (streamed routes). */
function readContent(raw: Uint8Array, encoding: ReadFileEncoding): string | Uint8Array {
  if (encoding === null) return raw;
  if (encoding === 'base64') return base64Encode(raw);
  // Fatal: invalid bytes must fail like Python's decode, not surface as mojibake.
  return new TextDecoder('utf-8', { fatal: true }).decode(raw);
}
