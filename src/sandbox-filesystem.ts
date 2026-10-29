import {
  SandboxFileExistsError,
  SandboxFileNotFoundError,
  SandboxFilesystemError,
  SandboxRequestError,
  SandboxServiceError,
} from './errors.js';
import type { FileStatEntry, FilesPutContent, FilesPutOptions, FilesPutReply } from './executor-gateway.js';
import { FILES_PROGRESS_INTERVAL_MS } from './constants.js';
import { shellQuote } from './shell.js';

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
};

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
   * cross-checked against the executor's reply. Older executors keep the
   * legacy JSON routes with the base64 transport (see TransferOptions.encoding).
   *
   * The transfer is bounded by a 60 s idle timeout only; a slow transfer
   * that keeps moving is never cut off.
   *
   * @throws SandboxFileNotFoundError if the local file doesn't exist.
   */
  async upload_file(local_path: string, remote_path: string, options: TransferOptions = {}): Promise<void> {
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

    const reporter = new ProgressReporter(options.progress, total);

    await translatingFilesErrors('upload file', remote_path, async () => {
      // A first constant-memory pass: the digest travels in X-Content-SHA256,
      // which precedes the body on the wire, and cross-checks the reply.
      const digest = await fileSha256(local_path);

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

  /**
   * Download a file from the sandbox to a local path.
   *
   * On executors v0.0.24+ the size comes from stat (never a HEAD), the bytes
   * stream into `<local>.part` and rename into place on success: a failed
   * download leaves the destination exactly as it was. Older executors
   * keep the legacy JSON routes with the base64 transport.
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

        let done = 0;
        const handle = await fs.open(part_path, 'w');
        try {
          for await (const chunk of this.sandbox.filesRead(remote_path, { signal: options.signal })) {
            await handle.write(chunk);
            done += chunk.byteLength;
            reporter.update(done);
          }
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
}

/** Interpret raw file bytes per the requested encoding (streamed routes). */
function readContent(raw: Uint8Array, encoding: ReadFileEncoding): string | Uint8Array {
  if (encoding === null) return raw;
  if (encoding === 'base64') return base64Encode(raw);
  // Fatal: invalid bytes must fail like Python's decode, not surface as mojibake.
  return new TextDecoder('utf-8', { fatal: true }).decode(raw);
}
