import { afterEach, describe, expect, it, vi } from 'vitest';


afterEach(() => {
  vi.restoreAllMocks();
});

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, stat, symlink, utimes, writeFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SandboxFilesystem, type SandboxPort } from './sandbox-filesystem.js';
import {
  SandboxFileNotFoundError,
  SandboxFilesystemError,
  SandboxRequestError,
} from './errors.js';
import {
  SYNC_BATCH_BYTES,
  buildArchive,
  extractArchive,
  walkLocal,
  type SyncEntry,
} from './sync.js';

/**
 * Pins filesystem.sync() against a miniature executor.
 *
 * The fake executor backs the streamed /files routes with a real directory
 * tree, using the sync engine's own walk/build/extract — so push and pull
 * are exercised end to end (real tar bytes, real extraction, real diff)
 * with zero network, mirroring koyeb/sandbox/test_filesystem_sync.py
 * (Python parity: ST-127's case set).
 */

async function write(path: string, content: Uint8Array | string = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

/** A file whose mtime differs by whole seconds from its creation. */
async function touchNew(path: string, content: Uint8Array | string = 'new', offsetSeconds = 5): Promise<void> {
  await write(path, content);
  const st = await stat(path);
  const bumped = st.mtimeMs / 1000 + offsetSeconds;
  await utimes(path, bumped, bumped);
}

/** Consume any body shape the fs layer hands to the transports. */
async function joinContent(content: unknown): Promise<Uint8Array> {
  if (content instanceof Uint8Array) return content;
  const chunks: Uint8Array[] = [];
  if (typeof (content as ReadableStream<Uint8Array>)?.getReader === 'function') {
    const reader = (content as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } else {
    for await (const chunk of content as AsyncIterable<Uint8Array> | NodeJS.ReadableStream) {
      chunks.push(chunk as Uint8Array);
    }
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A status error shaped like the transport's taxonomy errors. */
function statusError(status: number, body: string): SandboxRequestError {
  return new SandboxRequestError(status, body);
}

/** The streamed /files routes over a real directory (executor v0.0.24+).
 *
 *  Relative remote paths resolve under root — the fake's workdir — the
 *  way the executor's cwd resolves them. Archive puts are recorded as raw
 *  bytes so tests can open the exact tars that left the client. Multipart
 *  sessions are the executor's offset-addressed shape: parts land at
 *  offsets into a pre-sized buffer, complete answers 409 with the true
 *  missing ranges, then commits into the tree.
 */
class FakeExecutorTree {
  readonly calls: unknown[][] = [];
  readonly archives: Array<{ path: string; data: Uint8Array }> = [];
  private readonly sessions = new Map<
    string,
    { path: string; size: number; want: string | undefined; data: Uint8Array; spans: Array<[number, number]> }
  >();
  private nextSession = 0;

  constructor(readonly root: string) {
    mkdir(root, { recursive: true });
  }

  private resolve(path: string): string {
    if (path.startsWith('/')) return path;
    return join(this.root, ...path.split('/'));
  }

  callsOf(method: string): unknown[][] {
    return this.calls.filter((call) => call[0] === method);
  }

  async hasFilesRoutes(): Promise<boolean> {
    return true;
  }

  async exec(): Promise<{ stdout: string; stderr: string; code: number }> {
    return { stdout: '', stderr: '', code: 0 };
  }

  async request(route: string, _init: RequestInit, body?: { path?: string }): Promise<Record<string, unknown>> {
    // The legacy JSON routes the fs layer's deletes ride (there is no DELETE
    // on the streamed surface) — implemented, not stubbed. A missing target
    // answers 404 the way the executor does (lstat through a non-directory
    // reads as missing too — the type-flip arm).
    this.calls.push(['request', route, body?.path]);
    const target = this.resolve(body?.path ?? '');
    const exists = await lstat(target).then(() => true).catch(() => false);
    if (route === '/delete_file') {
      if (!exists) throw statusError(404, '{"error": "no such file or directory"}');
      await rm(target, { force: true });
      return {};
    }
    if (route === '/delete_dir') {
      if (!(await stat(target).then((st) => st.isDirectory()).catch(() => false))) {
        throw statusError(404, '{"error": "no such file or directory"}');
      }
      await rm(target, { recursive: true, force: true });
      return {};
    }
    return {};
  }

  async *filesList(
    path: string,
    options?: { recursive?: boolean; signal?: AbortSignal },
  ): AsyncGenerator<SyncEntry, void, unknown> {
    options?.signal?.throwIfAborted();
    this.calls.push(['files_list', path, options?.recursive ?? false]);
    const target = this.resolve(path);
    if (!(await stat(target).then((st) => st.isDirectory()).catch(() => false))) {
      throw statusError(404, '{"error": "no such file or directory"}');
    }
    for (const entry of await walkLocal(target)) yield entry;
  }

  async filesStat(path: string, options?: { hash?: 'sha256' }): Promise<Record<string, unknown>> {
    this.calls.push(['files_stat', path, options?.hash ?? null]);
    const target = this.resolve(path);
    const st = await stat(target); // follows symlinks, like the executor
    const lstat = await import('node:fs/promises').then((m) => m.lstat(target));
    const type = st.isDirectory() && !lstat.isSymbolicLink() ? 'dir' : lstat.isSymbolicLink() ? 'symlink' : 'file';
    const entry: Record<string, unknown> = {
      type,
      size: st.size,
      mode: (st.mode & 0o777).toString(8).padStart(4, '0'),
      mtime: new Date(Math.floor(st.mtimeMs / 1000) * 1000).toISOString(),
    };
    if (options?.hash === 'sha256') {
      entry['sha256'] = sha256(new Uint8Array(await readFile(target)));
    }
    return entry;
  }

  async filesArchivePut(path: string, content: unknown): Promise<{ files: number; bytes: number }> {
    const data = await joinContent(content);
    this.calls.push(['files_archive_put', path, data.byteLength]);
    this.archives.push({ path, data });
    const target = this.resolve(path);
    await mkdir(target, { recursive: true });
    const dir = await mkdtemp(join(tmpdir(), 'fake-put-'));
    try {
      const spool = join(dir, 'batch.tgz');
      await writeFile(spool, data);
      await extractArchive(spool, target);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return { files: 1, bytes: data.byteLength };
  }

  async *filesArchiveGet(path: string, options?: { exclude?: string[] }): AsyncGenerator<Uint8Array, void, unknown> {
    this.calls.push(['files_archive_get', path, [...(options?.exclude ?? [])]]);
    const target = this.resolve(path);
    const dir = await mkdtemp(join(tmpdir(), 'fake-get-'));
    try {
      const spool = join(dir, 'batch.tgz');
      await buildArchive(target, await walkLocal(target, options?.exclude ?? []), spool);
      for await (const chunk of createReadStream(spool, { highWaterMark: 64 * 1024 })) {
        yield chunk as Buffer;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async filesReadRange(path: string): Promise<{ status: number; etag: string; stream: AsyncGenerator<Uint8Array, void, unknown> }> {
    this.calls.push(['files_read_range', path]);
    const target = this.resolve(path);
    const st = await stat(target);
    return {
      status: 200,
      etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      stream: (async function* () {
        for await (const chunk of createReadStream(target)) yield chunk as Buffer;
      })(),
    };
  }

  async filesPut(path: string, content: unknown): Promise<{ size: number; sha256: string }> {
    const data = await joinContent(content);
    this.calls.push(['files_put', path, data.byteLength]);
    const target = this.resolve(path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, data);
    return { size: data.byteLength, sha256: sha256(data) };
  }

  async filesUploadOpen(path: string, size: number, options?: { sha256?: string }): Promise<Record<string, unknown>> {
    this.calls.push(['open', path, size, options?.sha256]);
    const id = `u-${this.nextSession++}`;
    this.sessions.set(id, {
      path: this.resolve(path),
      size,
      want: options?.sha256,
      data: new Uint8Array(size),
      spans: [],
    });
    return { upload_id: id, max_part_size: 100 * 1024 * 1024 };
  }

  async filesUploadPart(uploadId: string, offset: number, content: Uint8Array, options?: { sha256?: string }): Promise<void> {
    this.calls.push(['part', uploadId, offset]);
    const session = this.sessions.get(uploadId);
    if (session === undefined) throw statusError(404, '{"error": "unknown upload session"}');
    if (options?.sha256 !== undefined && sha256(content) !== options.sha256) {
      throw statusError(400, '{"error": "sha256 mismatch on part"}');
    }
    session.data.set(content, offset);
    session.spans.push([offset, offset + content.byteLength]);
  }

  async filesUploadStatus(uploadId: string): Promise<{ size: number; ranges: Array<{ start: number; end: number }> }> {
    const session = this.sessions.get(uploadId);
    if (session === undefined) throw statusError(404, '{"error": "unknown upload session"}');
    return { size: session.size, ranges: session.spans.map(([start, end]) => ({ start, end })) };
  }

  async filesUploadComplete(uploadId: string): Promise<{ size: number; sha256: string }> {
    this.calls.push(['complete', uploadId]);
    const session = this.sessions.get(uploadId);
    if (session === undefined) throw statusError(404, '{"error": "unknown upload session"}');
    const missing: Array<{ start: number; end: number }> = [];
    let at = 0;
    for (const [start, end] of [...session.spans].sort((a, b) => a[0] - b[0])) {
      if (start > at) missing.push({ start: at, end: start });
      at = Math.max(at, end);
    }
    if (at < session.size) missing.push({ start: at, end: session.size });
    if (missing.length > 0) {
      // The test-pinned 409 body shape (ST-136): {error, ranges:[{start, end}]}.
      throw statusError(409, JSON.stringify({ error: 'missing ranges', ranges: missing }));
    }
    this.sessions.delete(uploadId);
    const digest = sha256(session.data);
    if (session.want !== undefined && digest !== session.want) {
      throw statusError(400, `{"error": "sha256 mismatch: got ${digest}"}`);
    }
    await mkdir(join(session.path, '..'), { recursive: true });
    await writeFile(session.path, session.data);
    return { size: session.data.byteLength, sha256: digest };
  }

  async filesUploadAbort(uploadId: string): Promise<void> {
    this.calls.push(['abort', uploadId]);
    this.sessions.delete(uploadId);
  }

  async delete_file(path: string): Promise<Record<string, unknown>> {
    this.calls.push(['delete_file', path]);
    const target = this.resolve(path);
    await rm(target, { force: true });
    return {};
  }

  async delete_dir(path: string): Promise<Record<string, unknown>> {
    this.calls.push(['delete_dir', path]);
    const target = this.resolve(path);
    await rm(target, { recursive: true, force: true });
    return {};
  }
}

  /** The tree every push/pull test starts from: file, subdir file, symlink, empty dir. */
async function localTree(base: string, name = 'src'): Promise<string> {
  await freshSecond();
  const root = join(base, name);
  await write(join(root, 'a.txt'), 'hello');
  await chmod(join(root, 'a.txt'), 0o755);
  const pinned = 1774590000; // seconds: fs.utimes takes seconds as plain numbers
  await utimes(join(root, 'a.txt'), pinned, pinned);
  await write(join(root, 'sub', 'b.bin'), new Uint8Array([0x00, 0xff]));
  await utimes(join(root, 'sub', 'b.bin'), pinned, pinned);
  await symlink('a.txt', join(root, 'link'));
  await mkdir(join(root, 'empty'));
  return root;
}

/** Sleep until just past a second boundary. A symlink's mtime cannot
 *  round-trip through the archive (the executor cannot restore it either),
 *  so a no-op comparison of freshly-created links needs creation and
 *  extraction in the same whole second — Python's suite carries the same
 *  exposure and accepts the ms-window; this suite aligns instead, so a
 *  boundary crossing mid-test cannot flake it. */
async function freshSecond(): Promise<void> {
  const ms = Date.now() % 1000;
  if (ms < 500) return;
  await new Promise((resolve) => setTimeout(resolve, 1000 - ms + 10));
}

describe('sync push', () => {
  async function makeCase() {
    const base = await mkdtemp(join(tmpdir(), 'koyeb-sync-fs-'));
    const remoteRoot = join(base, 'workdir');
    const fake = new FakeExecutorTree(remoteRoot);
    const fs = new SandboxFilesystem(fake as unknown as SandboxPort);
    const cleanup = () => rm(base, { recursive: true, force: true });
    return { base, remoteRoot, fake, fs, cleanup };
  }

  /** The members of the nth recorded archive, sorted. */
  async function archiveMembers(fake: FakeExecutorTree, index = 0): Promise<string[]> {
    const { data } = fake.archives[index];
    const dir = await mkdtemp(join(tmpdir(), 'members-'));
    try {
      const spool = join(dir, 'a.tgz');
      await writeFile(spool, data);
      return (await extractArchive(spool, join(dir, 'x'))).sort();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('pushes a new tree: bytes, modes, symlinks, empty dirs', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      const result = await fs.sync(local, 'dst');

      expect(await readFile(join(remoteRoot, 'dst', 'a.txt'), 'utf-8')).toBe('hello');
      expect((await stat(join(remoteRoot, 'dst', 'a.txt'))).mode & 0o7777).toBe(0o755);
      expect(new Uint8Array(await readFile(join(remoteRoot, 'dst', 'sub', 'b.bin')))).toEqual(new Uint8Array([0x00, 0xff]));
      expect((await lstat(join(remoteRoot, 'dst', 'link'))).isSymbolicLink()).toBe(true);
      expect((await stat(join(remoteRoot, 'dst', 'empty'))).isDirectory()).toBe(true);
      expect(await archiveMembers(fake)).toEqual(['a.txt', 'empty', 'link', 'sub', 'sub/b.bin']);
      expect(result).toEqual({ uploaded: 5, deleted: 0, skipped: 0, bytes: 7 });
    } finally {
      await cleanup();
    }
  });

  it('a no-op push sends nothing beyond the listing', async () => {
    const { base, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await fs.sync(local, 'dst');
      fake.calls.length = 0;
      fake.archives.length = 0;

      const result = await fs.sync(local, 'dst');

      expect(fake.archives).toEqual([]);
      expect(result).toEqual({ uploaded: 0, deleted: 0, skipped: 5, bytes: 0 });
      expect(fake.callsOf('files_list')).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('a no-op push with checksum only stats', async () => {
    const { base, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await fs.sync(local, 'dst');
      fake.calls.length = 0;
      fake.archives.length = 0;

      const result = await fs.sync(local, 'dst', { checksum: true });

      expect(result.uploaded).toBe(0);
      expect(fake.archives).toEqual([]);
      // The honest no-op: checksum asks one sha256 stat per size-and-mtime-
      // equal file, nothing else.
      expect(fake.callsOf('files_stat')).toHaveLength(2);
      expect(fake.callsOf('files_archive_put')).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('pushes only the changed file', async () => {
    const { base, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await fs.sync(local, 'dst');
      fake.calls.length = 0;
      fake.archives.length = 0;
      await touchNew(join(local, 'sub', 'b.bin'), new Uint8Array([0x00, 0xee]));

      const result = await fs.sync(local, 'dst');

      expect(await archiveMembers(fake)).toEqual(['sub/b.bin']);
      expect(result).toEqual({ uploaded: 1, deleted: 0, skipped: 4, bytes: 2 });
    } finally {
      await cleanup();
    }
  });

  it('delete removes remote-only entries', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await fs.sync(local, 'dst');
      await write(join(remoteRoot, 'dst', 'extra.txt'));
      fake.calls.length = 0;

      const keep = await fs.sync(local, 'dst');
      expect(keep.skipped).toBe(6);
      expect(await stat(join(remoteRoot, 'dst', 'extra.txt'))).toBeTruthy();

      const gone = await fs.sync(local, 'dst', { delete: true });

      expect(await stat(join(remoteRoot, 'dst', 'extra.txt')).catch(() => null)).toBeNull();
      expect(gone.deleted).toBe(1);
      expect(fake.callsOf('request').filter((c) => c[1] === '/delete_file').map((c) => c[2])).toEqual(['dst/extra.txt']);
    } finally {
      await cleanup();
    }
  });

  it('delete prunes to the topmost directory', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await fs.sync(local, 'dst');
      await write(join(remoteRoot, 'dst', 'gone', 'child.txt'));
      fake.calls.length = 0;

      const result = await fs.sync(local, 'dst', { delete: true });

      expect(await stat(join(remoteRoot, 'dst', 'gone')).catch(() => null)).toBeNull();
      expect(fake.callsOf('request').filter((c) => c[1] === '/delete_dir').map((c) => c[2])).toEqual(['dst/gone']);
      expect(fake.callsOf('request').filter((c) => c[1] === '/delete_file')).toEqual([]);
      expect(result.deleted).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('delete spares an excluded remote file', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await write(join(remoteRoot, 'dst', 'skip.log'), 'keep me');
      fake.calls.length = 0;

      const result = await fs.sync(local, 'dst', { exclude: ['*.log'], delete: true });

      expect(await readFile(join(remoteRoot, 'dst', 'skip.log'), 'utf-8')).toBe('keep me');
      expect(fake.callsOf('request').filter((c) => c[1] === '/delete_file')).toEqual([]);
      expect(result.deleted).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('a type flip replaces a remote dir with the file', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await write(join(local, 'flip'), 'now a file');
      await write(join(remoteRoot, 'dst', 'flip', 'child.txt'));
      fake.calls.length = 0;

      const result = await fs.sync(local, 'dst', { delete: true });

      const remoteFlip = join(remoteRoot, 'dst', 'flip');
      expect((await stat(remoteFlip)).isFile()).toBe(true);
      expect(await readFile(remoteFlip, 'utf-8')).toBe('now a file');
      expect(result.deleted).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('delete spares excluded remote directories whole', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await write(join(remoteRoot, 'dst', 'backup', 'nested', 'keep.txt'));
      fake.calls.length = 0;

      const result = await fs.sync(local, 'dst', { exclude: ['backup'], delete: true });

      expect(await readFile(join(remoteRoot, 'dst', 'backup', 'nested', 'keep.txt'), 'utf-8')).toBe('x');
      expect(fake.callsOf('request').filter((c) => c[1] === '/delete_file')).toEqual([]);
      expect(result.deleted).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('routes an oversized file through upload_file (multipart), never the archive', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      const big = join(local, 'big.bin');
      const handle = await open(big, 'w');
      await handle.truncate(SYNC_BATCH_BYTES + 1);
      await handle.close();

      const result = await fs.sync(local, 'dst');

      // The rest of the tree still rides one archive batch.
      expect(fake.archives).toHaveLength(1);
      expect(await archiveMembers(fake)).not.toContain('big.bin');
      // The big file went through the multipart session flow.
      expect(fake.callsOf('open').map((c) => c[1])).toEqual(['dst/big.bin']);
      expect(fake.callsOf('files_put')).toEqual([]);
      expect((await stat(join(remoteRoot, 'dst', 'big.bin'))).size).toBe(SYNC_BATCH_BYTES + 1);
      expect(result).toEqual({ uploaded: 6, deleted: 0, skipped: 0, bytes: 7 + SYNC_BATCH_BYTES + 1 });
    } finally {
      await cleanup();
    }
  });

  it('dry_run computes without transfers', async () => {
    const { base, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);

      const result = await fs.sync(local, 'dst', { dry_run: true });

      expect(fake.archives).toEqual([]);
      expect(fake.callsOf('files_archive_put')).toEqual([]);
      expect(fake.callsOf('delete_file')).toEqual([]);
      expect(result.uploaded).toBe(5);
      expect(result.bytes).toBe(7);
    } finally {
      await cleanup();
    }
  });

  it('remote undefined uses the local path relative form', async () => {
    const { base, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await fs.sync(local);

      expect(fake.callsOf('files_list')[0][1]).toBe('src');
    } finally {
      await cleanup();
    }
  });

  it('checksum detects a same-size same-mtime change', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await fs.sync(local, 'dst');
      // Same size, same mtime, different bytes: only sha256 can see it.
      const target = join(remoteRoot, 'dst', 'a.txt');
      const st = await stat(target);
      await writeFile(target, 'HELLO');
      await utimes(target, st.mtimeMs / 1000, st.mtimeMs / 1000);
      fake.calls.length = 0;

      const without = await fs.sync(local, 'dst');
      const withSum = await fs.sync(local, 'dst', { checksum: true });

      expect(without.uploaded).toBe(0);
      expect(withSum.uploaded).toBe(1);
      // Both file entries passed the size+mtime test, so both hashed.
      expect(fake.callsOf('files_stat')).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it('a checksum stat failure wraps into the taxonomy', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      await fs.sync(local, 'dst');
      const target = join(remoteRoot, 'dst', 'a.txt');
      await writeFile(target, 'HELLO');
      const st = await stat(target);
      await utimes(target, st.mtimeMs / 1000, st.mtimeMs / 1000);
      fake.filesStat = async () => {
        throw statusError(500, '{"error": "boom"}');
      };

      const error = await fs
        .sync(local, 'dst', { checksum: true })
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toMatch(/boom/);
    } finally {
      await cleanup();
    }
  });

  it('pushes onto a missing remote root: the archive PUT creates it', async () => {
    const { base, remoteRoot, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);

      const result = await fs.sync(local, 'brand-new');

      expect(result.uploaded).toBe(5);
      expect(await readFile(join(remoteRoot, 'brand-new', 'a.txt'), 'utf-8')).toBe('hello');
    } finally {
      await cleanup();
    }
  });

  it('raises on a legacy executor', async () => {
    const base = await mkdtemp(join(tmpdir(), 'koyeb-sync-legacy-'));
    try {
      const local = await localTree(base);
      const legacy = { hasFilesRoutes: vi.fn(async () => false) };
      const fs = new SandboxFilesystem(legacy as unknown as SandboxPort);

      const error = await fs.sync(local, 'dst').catch((error: unknown) => error);

      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toMatch(/v0\.0\.24/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('refuses a missing local source, rsync-style', async () => {
    const { base, fs, cleanup } = await makeCase();
    try {
      const error = await fs.sync(join(base, 'nope'), 'dst').catch((error: unknown) => error);

      expect(error).toBeInstanceOf(SandboxFilesystemError);
    } finally {
      await cleanup();
    }
  });

  it('refuses a bad direction', async () => {
    const { base, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);

      const error = await fs
        .sync(local, 'dst', { direction: 'sideways' as never })
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/direction must be 'push' or 'pull'/);
    } finally {
      await cleanup();
    }
  });

  it('wraps listing errors into the taxonomy', async () => {
    const { base, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      const boom = new FakeExecutorTree(join(base, 'wd'));
      boom.filesList = async function* (): AsyncGenerator<SyncEntry, void, unknown> {
        throw statusError(500, '{"error": "boom"}');
      };
      const fsBoom = new SandboxFilesystem(boom as unknown as SandboxPort);

      const error = await fsBoom.sync(local, 'dst').catch((error: unknown) => error);

      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toMatch(/sync push/);
      void fs;
    } finally {
      await cleanup();
    }
  });

  it('surfaces the executor traversal refusals as client errors', async () => {
    const { base, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);

      // The three refusal kinds the executor answers 400 with: absolute
      // member names, `..` escapes, and links whose target escapes the root.
      const refusals = [
        'entry "/etc/evil.txt": name must stay inside the archive root',
        'entry "../evil.txt": name must stay inside the archive root',
        'entry "link": link target "../../outside" escapes the archive root',
      ];
      for (const message of refusals) {
        const refusing = new FakeExecutorTree(join(base, 'wd2'));
        refusing.filesArchivePut = async () => {
          throw statusError(400, JSON.stringify({ error: message }));
        };
        const fsRefusing = new SandboxFilesystem(refusing as unknown as SandboxPort);

        const error = await fsRefusing.sync(local, 'dst').catch((error: unknown) => error);

        expect(error).toBeInstanceOf(SandboxFilesystemError);
        expect((error as Error).message).toMatch(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      void fs;
    } finally {
      await cleanup();
    }
  });

  it('a pre-aborted signal sends nothing and surfaces the raw abort', async () => {
    const { base, fake, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);
      const controller = new AbortController();
      controller.abort();

      const error = await fs.sync(local, 'dst', { signal: controller.signal }).catch((error: unknown) => error);

      expect(fake.callsOf('files_list')).toEqual([]);
      expect((error as Error).name).toBe('AbortError');
    } finally {
      await cleanup();
    }
  });
});

describe('sync pull', () => {
  async function makeCase() {
    const base = await mkdtemp(join(tmpdir(), 'koyeb-sync-pull-'));
    const remoteRoot = join(base, 'workdir');
    const fake = new FakeExecutorTree(remoteRoot);
    const fs = new SandboxFilesystem(fake as unknown as SandboxPort);
    const cleanup = () => rm(base, { recursive: true, force: true });
    return { base, remoteRoot, fake, fs, cleanup };
  }

  it('a matching tree is a no-op', async () => {
    const { base, fake, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base, 'src');
      await fs.sync(source, 'dst');
      fake.calls.length = 0;

      const matching = await localTree(base, 'matching-dest');
      const result = await fs.sync(matching, 'dst', { direction: 'pull' });

      expect(result.downloaded).toBe(0);
      expect(fake.callsOf('files_archive_get')).toEqual([]);
      expect(result.skipped).toBe(5);
    } finally {
      await cleanup();
    }
  });

  it('pulls into an empty tree: bytes, modes, symlinks intact', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      fake.calls.length = 0;

      const dest = join(base, 'empty-dest');
      await mkdir(dest);
      const result = await fs.sync(dest, 'dst', { direction: 'pull' });

      expect(await readFile(join(dest, 'a.txt'), 'utf-8')).toBe('hello');
      expect((await stat(join(dest, 'a.txt'))).mode & 0o7777).toBe(0o755);
      expect((await lstat(join(dest, 'link'))).isSymbolicLink()).toBe(true);
      expect((await stat(join(dest, 'empty'))).isDirectory()).toBe(true);
      expect(result).toEqual({ downloaded: 5, deleted: 0, skipped: 0, bytes: 7 });
      expect(fake.callsOf('files_archive_get')).toHaveLength(1);
      void remoteRoot;
    } finally {
      await cleanup();
    }
  });

  it('a second pull sends nothing', async () => {
    const { base, fake, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      const dest = join(base, 'dest');
      await fs.sync(dest, 'dst', { direction: 'pull' });
      fake.calls.length = 0;

      const result = await fs.sync(dest, 'dst', { direction: 'pull' });

      expect(fake.callsOf('files_archive_get')).toEqual([]);
      expect(result.downloaded).toBe(0);
      expect(result.skipped).toBe(5);
    } finally {
      await cleanup();
    }
  });

  it('delete removes local-only entries', async () => {
    const { base, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      const dest = join(base, 'dest');
      await fs.sync(dest, 'dst', { direction: 'pull' });
      await write(join(dest, 'extra.txt'));

      const result = await fs.sync(dest, 'dst', { direction: 'pull', delete: true });

      expect(await stat(join(dest, 'extra.txt')).catch(() => null)).toBeNull();
      expect(result.deleted).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('delete prunes local descendants to the topmost', async () => {
    const { base, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      const dest = join(base, 'dest');
      await fs.sync(dest, 'dst', { direction: 'pull' });
      await write(join(dest, 'gone', 'child.txt'));

      const result = await fs.sync(dest, 'dst', { direction: 'pull', delete: true });

      expect(await stat(join(dest, 'gone')).catch(() => null)).toBeNull();
      expect(result.deleted).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('excludes remote entries from the plan', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      await write(join(remoteRoot, 'dst', 'skip.log'), 'not wanted');
      fake.calls.length = 0;

      const dest = join(base, 'dest');
      await mkdir(dest);
      const result = await fs.sync(dest, 'dst', { direction: 'pull', exclude: ['*.log'] });

      expect(await stat(join(dest, 'skip.log')).catch(() => null)).toBeNull();
      expect(await readFile(join(dest, 'a.txt'), 'utf-8')).toBe('hello');
      expect(result.downloaded).toBe(5);
      expect(fake.callsOf('files_archive_get')).toEqual([['files_archive_get', 'dst', ['*.log']]]);
    } finally {
      await cleanup();
    }
  });

  it('refuses loudly when the oversized exclude would prune a planned dir', async () => {
    const { base, remoteRoot, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      await write(join(remoteRoot, 'dst', 'x', 'backup', 'small.txt'), 'first');
      const dest = join(base, 'dest');
      await fs.sync(dest, 'dst', { direction: 'pull' });

      const big = join(remoteRoot, 'dst', 'backup');
      const handle = await open(big, 'w');
      await handle.truncate(SYNC_BATCH_BYTES + 1);
      await handle.close();
      await write(join(remoteRoot, 'dst', 'x', 'backup', 'small.txt'), 'changed');

      const error = await fs.sync(dest, 'dst', { direction: 'pull' }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toMatch(/x\/backup\/small\.txt/);
    } finally {
      await cleanup();
    }
  });

  it('refuses loudly when the oversized exclude would drop a same-suffixed member', async () => {
    const { base, remoteRoot, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      const big = join(remoteRoot, 'dst', 'big.bin');
      const handle = await open(big, 'w');
      await handle.truncate(SYNC_BATCH_BYTES + 1);
      await handle.close();
      await write(join(remoteRoot, 'dst', 'backup', 'big.bin'), 'new');
      const dest = join(base, 'dest');
      await mkdir(dest);

      const error = await fs.sync(dest, 'dst', { direction: 'pull' }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toMatch(/backup\/big\.bin/);
    } finally {
      await cleanup();
    }
  });

  it('a type flip replaces a local dir with the remote file', async () => {
    const { base, remoteRoot, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      await write(join(remoteRoot, 'dst', 'flip'), 'remote file');
      const dest = join(base, 'dest');
      await write(join(dest, 'flip', 'child.txt'));

      const result = await fs.sync(dest, 'dst', { direction: 'pull', delete: true });

      const localFlip = join(dest, 'flip');
      expect((await stat(localFlip)).isFile()).toBe(true);
      expect(await readFile(localFlip, 'utf-8')).toBe('remote file');
      expect(result.deleted).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('excludes descendants of excluded dirs from the plan', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      await write(join(remoteRoot, 'dst', 'x', 'backup', 'small.txt'), 'deep');
      const dest = join(base, 'dest');
      await fs.sync(dest, 'dst', { direction: 'pull' });
      fake.calls.length = 0;

      const result = await fs.sync(dest, 'dst', { direction: 'pull', exclude: ['backup'] });

      expect(result.downloaded).toBe(0);
      expect(fake.callsOf('files_archive_get')).toEqual([]);
      expect(await readFile(join(dest, 'x', 'backup', 'small.txt'), 'utf-8')).toBe('deep');
    } finally {
      await cleanup();
    }
  });

  it('does not download an excluded oversized file', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      const big = join(remoteRoot, 'dst', 'big.bin');
      const handle = await open(big, 'w');
      await handle.truncate(SYNC_BATCH_BYTES + 1);
      await handle.close();
      fake.calls.length = 0;

      const dest = join(base, 'dest');
      await mkdir(dest);
      const result = await fs.sync(dest, 'dst', { direction: 'pull', exclude: ['big.bin'] });

      expect(await stat(join(dest, 'big.bin')).catch(() => null)).toBeNull();
      expect(fake.callsOf('files_read_range')).toEqual([]);
      expect(result.downloaded).toBe(5);
    } finally {
      await cleanup();
    }
  });

  it('routes an oversized file through download_file, its bytes out of the archive', async () => {
    const { base, remoteRoot, fake, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      const big = join(remoteRoot, 'dst', 'big.bin');
      const handle = await open(big, 'w');
      await handle.truncate(SYNC_BATCH_BYTES + 1);
      await handle.close();
      const st = await stat(big);
      await utimes(big, st.mtimeMs / 1000 + 5, st.mtimeMs / 1000 + 5);
      fake.calls.length = 0;

      const dest = join(base, 'dest');
      await mkdir(dest);
      const result = await fs.sync(dest, 'dst', { direction: 'pull' });

      expect((await stat(join(dest, 'big.bin'))).size).toBe(SYNC_BATCH_BYTES + 1);
      expect(result.downloaded).toBe(6);
      expect(fake.callsOf('files_read_range')).toHaveLength(1);
      // The archive exclude carried the oversized name so its bytes
      // did not travel twice.
      const archiveGet = fake.callsOf('files_archive_get')[0];
      expect(archiveGet[2]).toContain('big.bin');
    } finally {
      await cleanup();
    }
  });

  it('dry_run pull touches nothing', async () => {
    const { base, fake, fs, cleanup } = await makeCase();
    try {
      const source = await localTree(base);
      await fs.sync(source, 'dst');
      fake.calls.length = 0;

      const dest = join(base, 'empty-dest');
      await mkdir(dest);
      const result = await fs.sync(dest, 'dst', { direction: 'pull', dry_run: true });

      expect(fake.callsOf('files_archive_get')).toEqual([]);
      expect(await readdir(dest)).toEqual([]);
      expect(result).toEqual({ downloaded: 5, deleted: 0, skipped: 0, bytes: 7 });
    } finally {
      await cleanup();
    }
  });

  it('refuses a missing remote source', async () => {
    const { base, fs, cleanup } = await makeCase();
    try {
      const local = await localTree(base);

      const error = await fs.sync(local, 'missing', { direction: 'pull' }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(SandboxFileNotFoundError);
    } finally {
      await cleanup();
    }
  });
});

describe('the ~10k-file tree acceptance run', () => {
  // The tree build + three full syncs over 10k members: this test pins the
  // ticket's acceptance criterion and needs a wider budget than the default.
  it(
    'first run transfers, rerun is a no-op, 1% delta sends only the delta',
    async () => {
    const base = await mkdtemp(join(tmpdir(), 'koyeb-sync-10k-'));
    try {
      const remoteRoot = join(base, 'workdir');
      const fake = new FakeExecutorTree(remoteRoot);
      const fs = new SandboxFilesystem(fake as unknown as SandboxPort);

      // ~10k files: 100 dirs x 100 files, 1-byte contents.
      const local = join(base, 'tree');
      await mkdir(local);
      const pinned = 1774590000; // seconds
      const paths: string[] = [];
      for (let d = 0; d < 100; d++) {
        const dir = join(local, `d${String(d).padStart(3, '0')}`);
        await mkdir(dir);
        for (let f = 0; f < 100; f++) {
          const path = join(dir, `f${String(f).padStart(3, '0')}.txt`);
          await writeFile(path, 'x');
          await utimes(path, pinned, pinned);
          paths.push(`d${String(d).padStart(3, '0')}/f${String(f).padStart(3, '0')}.txt`);
        }
      }

      // First run: everything transfers (10k files + 100 dirs).
      const first = await fs.sync(local, 'dst');
      expect(first.uploaded).toBe(10_000 + 100);
      expect(first.bytes).toBe(10_000);

      // Rerun: a no-op — nothing beyond the two listings.
      fake.calls.length = 0;
      fake.archives.length = 0;
      const again = await fs.sync(local, 'dst');
      expect(again).toEqual({ uploaded: 0, deleted: 0, skipped: 10_100, bytes: 0 });
      expect(fake.archives).toEqual([]);
      expect(fake.calls.map((c) => c[0])).toEqual(['files_list']);

      // 1% delta: rewrite 100 files with new content and bumped mtimes.
      const changed: string[] = [];
      for (let i = 0; i < 100; i++) {
        const rel = paths[i * 100];
        await writeFile(join(local, ...rel.split('/')), 'y');
        const st = await stat(join(local, ...rel.split('/')));
        await utimes(join(local, ...rel.split('/')), st.mtimeMs / 1000 + 10, st.mtimeMs / 1000 + 10);
        changed.push(rel);
      }

      fake.calls.length = 0;
      fake.archives.length = 0;
      const delta = await fs.sync(local, 'dst');

      // Only the changed set traveled.
      expect(delta.uploaded).toBe(100);
      expect(delta.bytes).toBe(100);
      const members: string[] = [];
      for (let i = 0; i < fake.archives.length; i++) {
        const { data } = fake.archives[i];
        const dir = await mkdtemp(join(tmpdir(), 'members-'));
        try {
          const spool = join(dir, 'a.tgz');
          await writeFile(spool, data);
          members.push(...(await extractArchive(spool, join(dir, 'x'))));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      expect(members.sort()).toEqual([...changed].sort());
    } finally {
      await rm(base, { recursive: true, force: true });
    }
    },
    120_000,
  );
});


describe('snapshot copy round-trips through the archive routes', () => {
  it('a directory lands binary-safe with modes and symlinks, via one sync push', async () => {
    const base = await mkdtemp(join(tmpdir(), 'koyeb-snapshot-copy-'));
    try {
      const remoteRoot = join(base, 'workdir');
      const fake = new FakeExecutorTree(remoteRoot);
      const filesystem = new SandboxFilesystem(fake as unknown as SandboxPort);
      const { DeclarativeSnapshot } = await import('./declarative-snapshot.js');
      const { Sandbox } = await import('./sandbox.js');

      // A binary, a mode, a symlink, a dir: what the legacy text walk lost.
      const src = join(base, 'src');
      await mkdir(join(src, 'sub'), { recursive: true });
      await writeFile(join(src, 'a.bin'), new Uint8Array([0x00, 0xff, 0x41]));
      await chmod(join(src, 'a.bin'), 0o755);
      await symlink('a.bin', join(src, 'link'));
      await writeFile(join(src, 'sub', 'b.txt'), 'text');

      const builder = {
        hasFilesRoutes: () => fake.hasFilesRoutes(),
        filesystem,
        exec: async () => ({ stdout: '', stderr: '', code: 0 }),
        snapshot: async () => ({ id: 'snap-9', operations: [] }),
        delete: async () => {},
      };
      const create = vi.spyOn(Sandbox, 'create').mockResolvedValue(builder as never);

      const snapshot = await new DeclarativeSnapshot('tpl', 'python:3.12', { api_token: 't' })
        .copy(src, 'remote')
        .build();

      // One archive push, no per-file writes.
      expect(fake.callsOf('files_archive_put')).toHaveLength(1);
      expect(fake.callsOf('files_put')).toEqual([]);
      // The tree landed byte-identical, with the mode and the link.
      expect(new Uint8Array(await readFile(join(remoteRoot, 'remote', 'a.bin')))).toEqual(
        new Uint8Array([0x00, 0xff, 0x41]),
      );
      expect((await stat(join(remoteRoot, 'remote', 'a.bin'))).mode & 0o777).toBe(0o755);
      expect((await lstat(join(remoteRoot, 'remote', 'link'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(remoteRoot, 'remote', 'link'), 'utf-8')).not.toThrow;
      expect(await readFile(join(remoteRoot, 'remote', 'sub', 'b.txt'), 'utf-8')).toBe('text');
      expect(snapshot.operations).toEqual(expect.arrayContaining([expect.stringContaining('copy: ')]));
      create.mockRestore();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
