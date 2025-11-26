import { Sandbox } from './sandbox.js';

type FileInfo = {
  content: string;
  encoding: string;
};

export class SandboxFilesystem {
  constructor(private readonly sandbox: Sandbox) {}

  async mkdir(path: string, recursive = false): Promise<void> {
    await this.sandbox.request('/make_dir', { method: 'POST' }, { path, recursive });
  }

  async list_dir(path = '.'): Promise<void> {
    return this.sandbox.request('/list_dir', { method: 'POST' }, { path });
  }

  async delete_dir(path: string): Promise<void> {
    await this.sandbox.request('/delete_dir', { method: 'POST' }, { path });
  }

  async write_file(path: string, content: string): Promise<void> {
    await this.sandbox.request('/write_file', { method: 'POST' }, { path, content });
  }

  async read_file(path: string): Promise<FileInfo> {
    return this.sandbox.request('/read_file', { method: 'POST' }, { path });
  }

  async rename_file(old_path: string, new_path: string): Promise<void> {
    await this.sandbox.exec(`mv ${old_path} ${new_path}`);
  }

  async rm(path: string, recursive = false): Promise<void> {
    if (recursive) {
      await this.sandbox.exec(`rm -rf ${path}`);
    } else {
      await this.sandbox.exec(`rm ${path}`);
    }
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.sandbox.exec(`test -e ${path}`);
    return result.code === 0;
  }

  async is_file(path: string): Promise<boolean> {
    const result = await this.sandbox.exec(`test -f ${path}`);
    return result.code === 0;
  }

  async is_dir(path: string): Promise<boolean> {
    const result = await this.sandbox.exec(`test -d ${path}`);
    return result.code === 0;
  }
}
