import { join } from 'node:path';

import { koyeb, KoyebApi } from './api.js';
import { DEFAULT_SNAPSHOT_POLL_INTERVAL, DEFAULT_SNAPSHOT_WAIT_TIMEOUT } from './constants.js';
import { MissingApiTokenError, SandboxError, SandboxTimeoutError } from './errors.js';
import { Sandbox } from './sandbox.js';
import { assert, getEnv, omitUndefined, waitFor } from './utils.js';

export type SnapshotType = 'FILESYSTEM' | 'FULL';
export type SnapshotStatus = 'INVALID' | 'CREATING' | 'AVAILABLE' | 'ERROR' | 'DELETING' | 'DELETED';

const API_SNAPSHOT_TYPES: Record<SnapshotType, koyeb.InstanceSnapshotType> = {
  FILESYSTEM: 'INSTANCE_SNAPSHOT_TYPE_FILESYSTEM',
  FULL: 'INSTANCE_SNAPSHOT_TYPE_FULL',
};

const SNAPSHOT_TYPES: Record<koyeb.InstanceSnapshotType, SnapshotType> = {
  INSTANCE_SNAPSHOT_TYPE_INVALID: 'FILESYSTEM',
  INSTANCE_SNAPSHOT_TYPE_FILESYSTEM: 'FILESYSTEM',
  INSTANCE_SNAPSHOT_TYPE_FULL: 'FULL',
};

const API_SNAPSHOT_STATUSES: Record<SnapshotStatus, koyeb.InstanceSnapshotStatus> = {
  INVALID: 'INSTANCE_SNAPSHOT_STATUS_INVALID',
  CREATING: 'INSTANCE_SNAPSHOT_STATUS_CREATING',
  AVAILABLE: 'INSTANCE_SNAPSHOT_STATUS_AVAILABLE',
  ERROR: 'INSTANCE_SNAPSHOT_STATUS_ERROR',
  DELETING: 'INSTANCE_SNAPSHOT_STATUS_DELETING',
  DELETED: 'INSTANCE_SNAPSHOT_STATUS_DELETED',
};

const SNAPSHOT_STATUSES: Record<koyeb.InstanceSnapshotStatus, SnapshotStatus> = {
  INSTANCE_SNAPSHOT_STATUS_INVALID: 'INVALID',
  INSTANCE_SNAPSHOT_STATUS_CREATING: 'CREATING',
  INSTANCE_SNAPSHOT_STATUS_AVAILABLE: 'AVAILABLE',
  INSTANCE_SNAPSHOT_STATUS_ERROR: 'ERROR',
  INSTANCE_SNAPSHOT_STATUS_DELETING: 'DELETING',
  INSTANCE_SNAPSHOT_STATUS_DELETED: 'DELETED',
};

export type ListSnapshotsFilter = Partial<{
  type: SnapshotType;
  status: SnapshotStatus;
  name: string;
  limit: string;
  offset: string;
  api_token: string;
  host: string;
}>;

/**
 * A snapshot of a sandbox instance's filesystem (or full state). Sandboxes can
 * be booted from a snapshot to skip provisioning, and snapshots can be built
 * declaratively from a recipe via {@link DeclarativeSnapshot}.
 */
export class Snapshot {
  constructor(
    public readonly id: string,
    public name: string,
    public readonly service_id: string,
    public readonly snapshot_type: SnapshotType,
    public status: SnapshotStatus,
    public readonly created_at?: string,
    public available_at?: string,
    public readonly deployment_id?: string,
    public readonly organization_id?: string,
    public readonly project_id?: string,
    public readonly instance_id?: string,
    public messages: string[] = [],
    public operations: string[] = [],
    public sandbox_secret?: string,
    private readonly api_token?: string,
    private readonly host?: string,
  ) {}

  private get api(): KoyebApi {
    return new KoyebApi(this.api_token, undefined, this.host);
  }

  static async get(id: string, options: { api_token?: string; host?: string } = {}): Promise<Snapshot> {
    const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');
    assert(token, new MissingApiTokenError());

    const api = new KoyebApi(token, undefined, options.host);
    const model = await api.getInstanceSnapshot(id);
    assert(model?.id, new SandboxError(`Snapshot ${id} not found`));

    return Snapshot.from_model(model, { api_token: token, host: options.host });
  }

  static async list(filter: ListSnapshotsFilter = {}): Promise<Snapshot[]> {
    const token = filter.api_token ?? getEnv('KOYEB_API_TOKEN');
    assert(token, new MissingApiTokenError());

    const api = new KoyebApi(token, undefined, filter.host);
    const models = await api.listInstanceSnapshots(
      omitUndefined({
        type: filter.type ? API_SNAPSHOT_TYPES[filter.type] : undefined,
        statuses: filter.status ? [API_SNAPSHOT_STATUSES[filter.status]] : undefined,
        name: filter.name,
        limit: filter.limit,
        offset: filter.offset,
      }),
    );

    return models
      .filter((model) => model.id)
      .map((model) => Snapshot.from_model(model, { api_token: token, host: filter.host }));
  }

  static from_model(
    model: koyeb.InstanceSnapshot,
    options: { api_token?: string; host?: string; sandbox_secret?: string } = {},
  ): Snapshot {
    return new Snapshot(
      model.id ?? '',
      model.name ?? '',
      model.service_id ?? '',
      model.type ? (SNAPSHOT_TYPES[model.type] ?? 'FILESYSTEM') : 'FILESYSTEM',
      model.status ? (SNAPSHOT_STATUSES[model.status] ?? 'INVALID') : 'INVALID',
      model.created_at,
      model.available_at,
      model.deployment_id,
      model.organization_id,
      model.project_id,
      model.instance_id,
      model.messages ?? [],
      [],
      options.sandbox_secret,
      options.api_token,
      options.host,
    );
  }

  async refresh(): Promise<void> {
    assert(this.id && this.api_token, new SandboxError('Cannot refresh snapshot without ID and API token'));

    const model = await this.api.getInstanceSnapshot(this.id);
    assert(model?.id, new SandboxError(`Snapshot ${this.id} not found`));

    this.name = model.name ?? this.name;
    this.status = model.status ? (SNAPSHOT_STATUSES[model.status] ?? 'INVALID') : 'INVALID';
    this.messages = model.messages ?? this.messages;
    this.available_at = model.available_at ?? this.available_at;
  }

  async wait_available(
    timeout = DEFAULT_SNAPSHOT_WAIT_TIMEOUT,
    pollInterval = DEFAULT_SNAPSHOT_POLL_INTERVAL,
  ): Promise<boolean> {
    const done = await waitFor(async () => {
      await this.refresh();
      return this.status === 'AVAILABLE' || this.status === 'ERROR';
    }, timeout, pollInterval);

    return done && this.status === 'AVAILABLE';
  }

  async delete(): Promise<void> {
    assert(this.id && this.api_token, new SandboxError('Cannot delete snapshot without ID and API token'));
    await this.api.deleteInstanceSnapshot(this.id);
  }

  async spawn(name?: string, options: Partial<{ api_token: string; host: string; sandbox_secret: string }> = {}): Promise<Sandbox> {
    return Sandbox.create({
      snapshot: this,
      ...(name !== undefined ? { name } : {}),
      ...(this.api_token !== undefined ? { api_token: this.api_token } : {}),
      ...(this.host !== undefined ? { host: this.host } : {}),
      ...(this.sandbox_secret !== undefined ? { sandbox_secret: this.sandbox_secret } : {}),
      ...options,
    });
  }
}

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
    if (!(options.api_token ?? getEnv('KOYEB_API_TOKEN'))) {
      throw new MissingApiTokenError();
    }
  }

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
    this.builder = await Sandbox.create({
      image: this.image,
      name: `builder-${this.name}`,
      ...(this.options.api_token !== undefined ? { api_token: this.options.api_token } : {}),
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

export type SnapshotOptions = Partial<{
  snapshot_type: SnapshotType;
  wait_available: boolean;
  timeout: number;
  poll_interval: number;
}>;

/** Resolve a snapshot reference (object or name/ID string) to an id + type. */
export async function resolveSnapshot(
  snapshot: Snapshot | string,
  api_token?: string,
  host?: string,
): Promise<{ id: string; type: SnapshotType }> {
  if (typeof snapshot !== 'string') {
    return { id: snapshot.id, type: snapshot.snapshot_type };
  }

  try {
    const found = await Snapshot.get(snapshot, { api_token, host });
    return { id: found.id, type: found.snapshot_type };
  } catch {
    // A failed name lookup is not fatal: Python falls back to the raw string.
    try {
      const matches = await Snapshot.list({ name: snapshot, api_token, host });
      const byName = matches.find((candidate) => candidate.name === snapshot);

      if (byName) {
        return { id: byName.id, type: byName.snapshot_type };
      }
    } catch {
      // Fall through to the ID fallback.
    }

    // Last resort: treat the string as an ID (Python-parity fallback).
    return { id: snapshot, type: 'FILESYSTEM' };
  }
}


