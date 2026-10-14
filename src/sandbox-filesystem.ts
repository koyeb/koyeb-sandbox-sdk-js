import { SandboxFileExistsError, SandboxFileNotFoundError, SandboxFilesystemError } from './errors.js';
import { shellQuote } from './shell.js';

export type FileContent = string | Uint8Array;

export type FileInfo = {
  content: FileContent;
  encoding: string;
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
function checkExecutorError(response: { error?: unknown }, path: string, what: string): void {
  const error = response?.error;

  if (typeof error !== 'string' || error.length === 0) {
    return;
  }

  if (matchesPatterns(error, NOT_FOUND_PATTERNS)) {
    throw new SandboxFileNotFoundError(`${what} failed: ${error} (path: ${path})`);
  }
  if (matchesPatterns(error, EXISTS_PATTERNS)) {
    throw new SandboxFileExistsError(`${what} failed: ${error} (path: ${path})`);
  }

  throw new SandboxFilesystemError(`${what} failed: ${error} (path: ${path})`);
}

/** Chunk size keeping String.fromCharCode spreads within engine argument limits. */
const BASE64_CHUNK = 0x8000;

/** Base64-encode bytes to the ASCII wire form (the Python SDK's base64.b64encode(...).decode("ascii")). */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/** atob yields a binary string; repack it into bytes. */
function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Run a decode, classifying failures like Python wraps UnicodeDecodeError. */
function decodeOrThrow<T>(decode: () => T, what: string, path: string): T {
  try {
    return decode();
  } catch (error) {
    throw new SandboxFilesystemError(`${what} failed: ${String(error)} (path: ${path})`);
  }
}

/** Decode bytes to a string in the given encoding, like Python's bytes.decode(encoding). */
function decodeBytes(bytes: Uint8Array, encoding: string, what: string, path: string): string {
  return decodeOrThrow(() => new TextDecoder(encoding, { fatal: true }).decode(bytes), what, path);
}

/** The two transport calls filesystem operations need; Sandbox satisfies it structurally. */
type SandboxPort = {
  exec: (
    cmd: string,
    options?: { cwd?: string; env?: Record<string, string> },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  request: (path: string, init: RequestInit, body?: unknown) => Promise<any>;
};

export class SandboxFilesystem {
  constructor(private readonly sandbox: SandboxPort) {}

  async mkdir(path: string, recursive = false): Promise<void> {
    checkExecutorError(await this.sandbox.request('/make_dir', { method: 'POST' }, { path, recursive }), path, 'mkdir');
  }

  async list_dir(path = '.'): Promise<string[]> {
    const result = await this.sandbox.request('/list_dir', { method: 'POST' }, { path });
    checkExecutorError(result, path, 'list_dir');
    return result.entries;
  }

  async delete_dir(path: string): Promise<void> {
    checkExecutorError(await this.sandbox.request('/delete_dir', { method: 'POST' }, { path }), path, 'delete_dir');
  }

  /** Python-SDK parity: strings travel as-is; bytes travel per `encoding` — 'base64' is the executor's binary wire encoding. */
  async write_file(path: string, content: FileContent, encoding = 'utf-8'): Promise<void> {
    const payload =
      typeof content === 'string'
        ? { path, content }
        : encoding === 'base64'
          ? { path, content: encodeBase64(content), is_base64: true }
          : { path, content: decodeBytes(content, encoding, 'write_file', path) };

    checkExecutorError(await this.sandbox.request('/write_file', { method: 'POST' }, payload), path, 'write_file');
  }

  /** Bulk write helper; entries carry optional per-file encoding like the Python SDK's write_files. */
  async write_files(files: Array<{ path: string; content: FileContent; encoding?: string }>): Promise<void> {
    await Promise.all(files.map(({ path, content, encoding }) => this.write_file(path, content, encoding)));
  }

  /** Python-SDK parity: `encoding: 'base64'` yields bytes; executors flagging binary responses (the Go wire contract's is_base64) do too. */
  async read_file(path: string, encoding = 'utf-8'): Promise<FileInfo> {
    const result = await this.sandbox.request('/read_file', { method: 'POST' }, { path });
    checkExecutorError(result, path, 'read_file');

    if (encoding === 'base64' || result.is_base64 === true) {
      // An executor that omits empty content (Go omitempty) still means b'', like Python.
      const content = decodeOrThrow(() => decodeBase64(result.content ?? ''), 'read_file', path);
      return { content, encoding: 'base64' };
    }

    return { content: result.content, encoding };
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
    checkExecutorError(await this.sandbox.request('/delete_file', { method: 'POST' }, { path }), path, 'delete_file');
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
   * Uploads local_path from the caller's machine to remote_path in the sandbox.
   * Python-SDK parity: the local file is read as bytes, so binary files survive with encoding: 'base64'.
   */
  async upload_file(local_path: string, remote_path: string, encoding = 'utf-8'): Promise<void> {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(local_path);

    await this.write_file(remote_path, content, encoding);
  }

  /**
   * Downloads remote_path from the sandbox to local_path on the caller's machine.
   * Same argument order as the Python SDK and the CLI: remote first, local second.
   * Python-SDK parity: binary content lands on disk as-is; string content is encoded with `encoding`.
   */
  async download_file(remote_path: string, local_path: string, encoding = 'utf-8'): Promise<void> {
    const fs = await import('node:fs/promises');
    const fileInfo = await this.read_file(remote_path, encoding);

    if (fileInfo.content instanceof Uint8Array) {
      await fs.writeFile(local_path, fileInfo.content);
    } else {
      await fs.writeFile(local_path, fileInfo.content, { encoding: encoding as BufferEncoding });
    }
  }
}
