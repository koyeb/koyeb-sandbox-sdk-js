import { Sandbox } from './sandbox.js';
import { SandboxFileExistsError, SandboxFileNotFoundError, SandboxFilesystemError } from './errors.js';
import { shellQuote } from './utils.js';

type FileInfo = {
  content: string;
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

export class SandboxFilesystem {
  constructor(private readonly sandbox: Sandbox) {}

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

  async write_file(path: string, content: string): Promise<void> {
    checkExecutorError(
      await this.sandbox.request('/write_file', { method: 'POST' }, { path, content }),
      path,
      'write_file',
    );
  }

  async write_files(files: Array<{ path: string; content: string }>): Promise<void> {
    await Promise.all(files.map(({ path, content }) => this.write_file(path, content)));
  }

  async read_file(path: string): Promise<FileInfo> {
    const result = await this.sandbox.request('/read_file', { method: 'POST' }, { path });
    checkExecutorError(result, path, 'read_file');
    return result;
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

  async upload_file(local_path: string, remote_path: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(local_path);

    await this.write_file(remote_path, content.toString());
  }

  async download_file(local_path: string, remote_path: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const fileInfo = await this.read_file(remote_path);

    await fs.writeFile(local_path, fileInfo.content);
  }
}
