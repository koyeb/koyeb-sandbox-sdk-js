import { Sandbox } from './sandbox.js';
import { SandboxFileExistsError, SandboxFileNotFoundError, SandboxFilesystemError } from './errors.js';
import { escapeShellArg } from './utils.js';

type FileInfo = {
  content: string;
  encoding: string;
};

export class SandboxFilesystem {
  constructor(private readonly sandbox: Sandbox) {}

  private assertSuccess(response: unknown, operation: string, path: string): void {
    if (!response || typeof response !== 'object') {
      return;
    }

    const result = response as { error?: unknown; success?: unknown };
    if (!result.error && result.success !== false) {
      return;
    }

    const message = String(result.error ?? 'Unknown error');
    if (/no such file|not found/i.test(message)) {
      throw new SandboxFileNotFoundError(`${operation}: ${path}`);
    }
    if (/already exists|\bexists\b/i.test(message)) {
      throw new SandboxFileExistsError(`${operation}: ${path}`);
    }

    throw new SandboxFilesystemError(`${operation}: ${message}`);
  }

  async mkdir(path: string, recursive = false): Promise<void> {
    const response = await this.sandbox.request('/make_dir', { method: 'POST' }, { path, recursive });
    this.assertSuccess(response, 'Failed to create directory', path);
  }

  async list_dir(path = '.'): Promise<string[]> {
    const result = await this.sandbox.request('/list_dir', { method: 'POST' }, { path });
    this.assertSuccess(result, 'Failed to list directory', path);
    return result.entries ?? [];
  }

  async delete_dir(path: string): Promise<void> {
    const response = await this.sandbox.request('/delete_dir', { method: 'POST' }, { path });
    this.assertSuccess(response, 'Failed to delete directory', path);
  }

  async write_file(path: string, content: string): Promise<void> {
    const response = await this.sandbox.request('/write_file', { method: 'POST' }, { path, content });
    this.assertSuccess(response, 'Failed to write file', path);
  }

  async write_files(files: Array<{ path: string; content: string }>): Promise<void> {
    await Promise.all(files.map(({ path, content }) => this.write_file(path, content)));
  }

  async read_file(path: string): Promise<FileInfo> {
    const response = await this.sandbox.request('/read_file', { method: 'POST' }, { path });
    this.assertSuccess(response, 'Failed to read file', path);
    return response;
  }

  async rename_file(old_path: string, new_path: string): Promise<void> {
    const result = await this.sandbox.exec(`mv ${escapeShellArg(old_path)} ${escapeShellArg(new_path)}`);
    if (result.code !== 0) {
      throw new SandboxFilesystemError(`Failed to rename file: ${result.stderr}`);
    }
  }

  async rm(path: string, recursive = false): Promise<void> {
    if (recursive) {
      const result = await this.sandbox.exec(`rm -rf ${escapeShellArg(path)}`);
      if (result.code !== 0) {
        throw new SandboxFilesystemError(`Failed to remove path: ${result.stderr}`);
      }
    } else {
      const result = await this.sandbox.exec(`rm ${escapeShellArg(path)}`);
      if (result.code !== 0) {
        throw new SandboxFilesystemError(`Failed to remove path: ${result.stderr}`);
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.sandbox.exec(`test -e ${escapeShellArg(path)}`);
    return result.code === 0;
  }

  async is_file(path: string): Promise<boolean> {
    const result = await this.sandbox.exec(`test -f ${escapeShellArg(path)}`);
    return result.code === 0;
  }

  async is_dir(path: string): Promise<boolean> {
    const result = await this.sandbox.exec(`test -d ${escapeShellArg(path)}`);
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
