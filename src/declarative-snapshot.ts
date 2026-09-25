import { join } from 'node:path';

import { resolveClient } from './credentials.js';
import { SandboxError } from './errors.js';
// Sandbox is referenced only at build time, so the module imports it
// dynamically inside build() — the import graph stays acyclic.
import type { Sandbox } from './sandbox.js';
import type { Snapshot } from './snapshot.js';

export type TemplateOptions = Partial<{
  workdir: string;
  api_token: string;
  host: string;
  delete_builder: boolean;
}>;

/**
 * Fluent builder that turns a recipe (files, local copies, commands) into a
 * snapshot: it runs the recipe on a throwaway builder sandbox and snapshots
 * the result, ready to spawn pre-configured sandboxes from.
 */
export class DeclarativeSnapshot {
  private readonly files = new Map<string, string>();
  private readonly copies: Array<[string, string]> = [];
  private readonly commands: Array<{ command: string; cwd?: string }> = [];
  private readonly operations: string[] = [];
  private builder?: Sandbox;

  constructor(
    private readonly name: string,
    private readonly image: string,
    private readonly options: TemplateOptions = {},
  ) {
    // Validate presence now; build() threads the resolved token into Sandbox.create.
    this.resolvedToken = resolveClient(options).token;
  }

  private readonly resolvedToken: string;

  file(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  copy(src: string, dst: string): this {
    this.copies.push([src, dst]);
    return this;
  }

  run(command: string, cwd?: string): this {
    this.commands.push({ command, cwd });
    return this;
  }

  async build(snapshotName?: string): Promise<Snapshot> {
    const { Sandbox } = await import('./sandbox.js');

    this.builder = await Sandbox.create({
      image: this.image,
      name: `builder-${this.name}`,
      api_token: this.resolvedToken,
      ...(this.options.host !== undefined ? { host: this.options.host } : {}),
    });

    try {
      if (this.options.workdir) {
        this.operations.push(`set_workdir: ${this.options.workdir}`);
        await this.builder.filesystem.mkdir(this.options.workdir);
      }

      for (const [path, content] of this.files) {
        this.operations.push(`create_file: ${path}`);
        await this.builder.filesystem.write_file(path, content);
      }

      for (const [src, dst] of this.copies) {
        this.operations.push(`copy: ${src} -> ${dst}`);
        await this.copyLocal(src, dst);
      }

      for (const { command, cwd } of this.commands) {
        const cmd = cwd ? `cd ${cwd} && ${command}` : command;
        this.operations.push(`run: ${cmd}`);

        // Recipe commands can install packages; give them Python's 300s budget.
        const result = await this.builder.exec(cmd, { timeout: 300 });
        if (result.code !== 0) {
          throw new SandboxError(`Command failed: ${cmd}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
        }
      }

      const snapshot = await this.builder.snapshot(snapshotName ?? this.name, {
        snapshot_type: 'FILESYSTEM',
        wait_available: true,
      });
      snapshot.operations.push(...this.operations);

      return snapshot;
    } finally {
      if (this.options.delete_builder !== false && this.builder) {
        await this.builder.delete().catch(() => {
          // best-effort teardown; keep the failure that matters
        });
      }
    }
  }

  private async copyLocal(src: string, dst: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(src);

    if (stat.isFile()) {
      await this.builder!.filesystem.write_file(dst, await fs.readFile(src, 'utf8'));
      return;
    }

    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
      const target = `${dst}/${entry.name}`;
      // Python creates each subdirectory before writing into it.
      if (entry.isDirectory()) {
        await this.builder!.filesystem.mkdir(target);
      }
      await this.copyLocal(join(src, entry.name), target);
    }
  }
}
