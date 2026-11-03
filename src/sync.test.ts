import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

import { execSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import {
  SYNC_BATCH_BYTES,
  buildArchive,
  diff,
  excluded,
  extractArchive,
  formatMtime,
  hashCandidates,
  joinLocal,
  mtimeSeconds,
  pathExcluded,
  pathMatch,
  planBatches,
  pruneDescendants,
  relativeRemote,
  remoteJoin,
  walkLocal,
  type SyncEntry,
} from './sync.js';
import { BLOCK_SIZE, ustarHeaders, ustarTrailer, type UstarMember } from './ustar.js';

/**
 * Pins the pure diff engine behind filesystem.sync().
 *
 * Python parity: koyeb/sandbox/test_sync.py — the case set mirrors it. The
 * engine holds the decisions (walking, matching, diffing, planning, tar
 * batches) with no executor I/O, so every rule is testable against plain
 * data and tmpdir trees.
 */

const encoder = new TextEncoder();

/** One FileEntry: the NDJSON shape the executor lists and the walk emits. */
function entry(path: string, type: string, size = 0, mtime = '2026-10-27T10:00:00Z'): SyncEntry {
  return { path, type, size, mode: '0644', mtime };
}

async function withTmpDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'koyeb-sync-test-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function make(root: string, rel: string, content = 'x'): Promise<string> {
  const path = joinLocal(root, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe('pathMatch', () => {
  it('matches literals exactly', () => {
    expect(pathMatch('a.txt', 'a.txt')).toBe(true);
    expect(pathMatch('a.txt', 'b.txt')).toBe(false);
  });

  it('never crosses the separator with a star', () => {
    expect(pathMatch('*.py', 'a.py')).toBe(true);
    expect(pathMatch('*.py', 'a/b.py')).toBe(false);
  });

  it('matches a single non-separator with a question mark', () => {
    expect(pathMatch('a?c', 'abc')).toBe(true);
    expect(pathMatch('a?c', 'a/c')).toBe(false);
  });

  it('matches character classes', () => {
    expect(pathMatch('[a-c]x', 'bx')).toBe(true);
    expect(pathMatch('[a-c]x', 'dx')).toBe(false);
  });

  it('lets a star match the empty rest', () => {
    expect(pathMatch('a*', 'a')).toBe(true);
    expect(pathMatch('*', 'anything')).toBe(true);
  });

  it('raises on a malformed class, like the executor 400s', () => {
    expect(() => pathMatch('x[', 'x')).toThrow();
  });

  it('raises on a trailing escape', () => {
    expect(() => pathMatch('a\\', 'x')).toThrow();
    expect(() => pathMatch('a\\', 'aXY')).toThrow();
  });

  it('raises on a malformed later chunk after an earlier mismatch', () => {
    expect(() => pathMatch('a*x[', 'b')).toThrow();
  });

  it('a failed match with a valid mid-escape remainder is a mismatch, not an error', () => {
    expect(pathMatch('x\\y', 'a')).toBe(false);
  });

  it('treats a mismatched final unit as a failed match, not a chunk end', () => {
    // The buggy reading matched a*b against b (Go: false).
    const rows: Array<[string, string, boolean]> = [
      ['a*b', 'b', false],
      ['a?b', 'ab', false],
      ['ab', 'b', false],
      ['*b', 'b', true],
    ];
    for (const [pattern, name, want] of rows) {
      expect(pathMatch(pattern, name)).toBe(want);
    }
  });

  it('matches the Go cross-checked arms', () => {
    // Every row verified against Go's path.Match (Python parity rows).
    const rows: Array<[string, string, boolean]> = [
      ['*', 'a/b', false],
      ['a/*', 'a/b/c', false],
      ['a/*/c', 'a/b/c', true],
      ['a*b*c', 'aXbYc', true],
      ['a*b*c', 'a/b/c', false],
      ['sub/.git', '.git', false],
      ['*.log', 'sub/a.log', false],
      ['[!a-c]x', 'dx', false],
      ['[^a-c]x', 'dx', true],
      ['a\\*b', 'a*b', true],
      ['a\\*b', 'aXb', false],
      ['[\\]]', ']', true],
      ['[\\-]', '-', true],
      ['[\\-]', 'x', false],
      ['', 'x', false],
      ['', '', true],
    ];
    for (const [pattern, name, want] of rows) {
      expect(pathMatch(pattern, name), `${pattern} vs ${name}`).toBe(want);
    }
  });
});

describe('excluded', () => {
  it('matches the path directly', () => {
    expect(excluded('a.log', ['*.log'])).toBe(true);
  });

  it('matches a /-boundary suffix, like tar --exclude', () => {
    expect(excluded('sub/a.log', ['*.log'])).toBe(true);
    expect(excluded('sub/a.txt', ['*.log'])).toBe(false);
  });

  it('does not match a non-matching path', () => {
    expect(excluded('a.txt', ['*.log'])).toBe(false);
    expect(excluded('a/b/c.txt', ['*.log', '*.py'])).toBe(false);
  });

  it('matches when any pattern matches', () => {
    expect(excluded('a.log', ['*.py', '*.log'])).toBe(true);
  });

  it('matches a directory entry by its own name', () => {
    // The pruning rule: a dir entry matches, the walk never descends.
    expect(excluded('.git', ['.git'])).toBe(true);
    expect(excluded('sub/.git', ['.git'])).toBe(true);
  });
});

describe('pathExcluded', () => {
  it('matches the path itself', () => {
    expect(pathExcluded('a.log', ['*.log'])).toBe(true);
  });

  it('matches a directory prefix of the path', () => {
    expect(pathExcluded('backup/nested/keep.txt', ['backup'])).toBe(true);
  });

  it('does not match a sibling prefix', () => {
    expect(pathExcluded('backupx/keep.txt', ['backup'])).toBe(false);
  });

  it('does not match deep non-matching paths', () => {
    expect(pathExcluded('a/b/c.txt', ['*.log'])).toBe(false);
  });

  it('matches a class pattern through a prefix', () => {
    // A metachar pattern prunes same-named dirs via the class rule.
    expect(pathExcluded('data1/x', ['data[1]'])).toBe(true);
  });
});

describe('formatMtime', () => {
  it('keeps and trims nanoseconds', () => {
    expect(formatMtime(1774590000123456789n)).toMatch(/\.123456789Z$/);
    expect(formatMtime(1774590000500000000n)).toMatch(/\.5Z$/);
    expect(formatMtime(1774590000000001000n)).toMatch(/\.000001Z$/);
  });

  it('omits a zero fraction', () => {
    const formatted = formatMtime(1774590000000000000n);
    expect(formatted).toMatch(/Z$/);
    expect(formatted).not.toContain('.');
  });

  it('floors to whole seconds in mtimeSeconds', () => {
    expect(mtimeSeconds('2026-10-27T10:00:00.123456789Z')).toBe(mtimeSeconds('2026-10-27T10:00:00Z'));
    expect(mtimeSeconds('2026-10-27T10:00:00.999Z')).toBe(mtimeSeconds('2026-10-27T10:00:00Z'));
  });

  it('round-trips through mtimeSeconds', () => {
    for (const ns of [1774590000000000000n, 1774590000123456789n, 1774590059500000000n]) {
      expect(mtimeSeconds(formatMtime(ns))).toBe(Number(ns / 1_000_000_000n));
    }
  });
});

describe('walkLocal', () => {
  it('raises on an unreadable subtree instead of dropping it', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    await withTmpDir(async (root) => {
      await make(root, 'visible.txt');
      await mkdir(join(root, 'locked'));
      await make(root, 'locked/inner.txt');
      await chmod(join(root, 'locked'), 0o000);

      try {
        await expect(walkLocal(root)).rejects.toThrow();
      } finally {
        await chmod(join(root, 'locked'), 0o755);
      }
    });
  });

  it('emits entries in the FileEntry shape', async () => {
    await withTmpDir(async (root) => {
      await make(root, 'a.txt', 'hello');
      await mkdir(join(root, 'sub'));
      await make(root, 'sub/b.bin', '12345');
      await symlink('a.txt', join(root, 'link.txt'));
      await symlink('sub', join(root, 'sublink'));

      const entries = await walkLocal(root);
      const byPath = new Map(entries.map((e) => [e.path, e]));
      expect([...byPath.keys()].sort()).toEqual(['a.txt', 'link.txt', 'sub', 'sub/b.bin', 'sublink']);
      expect(byPath.get('a.txt')!.type).toBe('file');
      expect(byPath.get('a.txt')!.size).toBe(5);
      expect(byPath.get('sub')!.type).toBe('dir');
      expect(byPath.get('link.txt')!.type).toBe('symlink');
      expect(byPath.get('link.txt')!.size).toBe('a.txt'.length);
      // A symlinked dir is listed as a link, not descended into.
      expect(byPath.get('sublink')!.type).toBe('symlink');
      for (const e of entries) {
        expect(() => mtimeSeconds(e.mtime)).not.toThrow();
        expect(e.mtime).toMatch(/^20\d\d-/);
        expect(e.mode).toMatch(/^[0-7]{4}$/);
      }
    });
  });

  it('never lists the root itself', async () => {
    await withTmpDir(async (root) => {
      await make(root, 'a.txt');
      const entries = await walkLocal(root);
      expect(entries.map((e) => e.path)).toEqual(['a.txt']);
    });
  });

  it('skips special files', { skip: process.platform === 'win32' }, async () => {
    await withTmpDir(async (root) => {
      await make(root, 'a.txt');
      execSync(`mkfifo ${JSON.stringify(join(root, 'pipe'))}`);
      const entries = await walkLocal(root);
      expect(entries.map((e) => e.path)).toEqual(['a.txt']);
    });
  });

  it('prunes an excluded directory whole', async () => {
    await withTmpDir(async (root) => {
      await make(root, 'a.txt');
      await make(root, '.git/config');
      await make(root, 'sub/c.txt');
      const entries = await walkLocal(root, ['.git']);
      expect(entries.map((e) => e.path).sort()).toEqual(['a.txt', 'sub', 'sub/c.txt']);
    });
  });

  it('excludes files by suffix', async () => {
    await withTmpDir(async (root) => {
      await make(root, 'a.py');
      await make(root, 'sub/b.py');
      await make(root, 'sub/c.txt');
      const entries = await walkLocal(root, ['*.py']);
      expect(entries.map((e) => e.path).sort()).toEqual(['sub', 'sub/c.txt']);
    });
  });

  it('reports real permissions in the mode', async () => {
    await withTmpDir(async (root) => {
      const path = await make(root, 'a.sh');
      await chmod(path, 0o755);
      const [entry] = await walkLocal(root);
      expect(entry.mode).toBe('0755');
    });
  });

  it('reports the file mtime at nanosecond precision', async () => {
    await withTmpDir(async (root) => {
      const path = await make(root, 'a.txt');
      await utimes(path, 1774590000.123456789, 1774590000.123456789);
      const [entry] = await walkLocal(root);
      expect(mtimeSeconds(entry.mtime)).toBe(1774590000);
    });
  });
});

describe('diff', () => {
  it('transfers a new file', () => {
    const result = diff([entry('a.txt', 'file', 5)], []);
    expect(result.toTransfer.map((e) => e.path)).toEqual(['a.txt']);
    expect(result.bytes).toBe(5);
  });

  it('skips an identical file', () => {
    const same = entry('a.txt', 'file', 5, '2026-10-27T10:00:00.100Z');
    const result = diff([same], [same]);
    expect(result.toTransfer).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('transfers on a size difference', () => {
    const result = diff([entry('a.txt', 'file', 5)], [entry('a.txt', 'file', 6)]);
    expect(result.toTransfer.map((e) => e.path)).toEqual(['a.txt']);
  });

  it('ignores a directory size difference', () => {
    // A directory's st_size is a filesystem-format artifact (APFS ~64,
    // ext4 4096) that can never converge cross-filesystem.
    const result = diff([entry('d', 'dir', 64)], [entry('d', 'dir', 4096)]);
    expect(result.toTransfer).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('transfers on an mtime difference past a second', () => {
    const result = diff(
      [entry('a.txt', 'file', 5, '2026-10-27T10:00:01Z')],
      [entry('a.txt', 'file', 5, '2026-10-27T10:00:00Z')],
    );
    expect(result.toTransfer.map((e) => e.path)).toEqual(['a.txt']);
  });

  it('skips an mtime difference within the same second', () => {
    // tar PAX mtime cannot round-trip nanoseconds; the diff is
    // whole-second like rsync's default.
    const result = diff(
      [entry('a.txt', 'file', 5, '2026-10-27T10:00:00.900Z')],
      [entry('a.txt', 'file', 5, '2026-10-27T10:00:00.100Z')],
    );
    expect(result.toTransfer).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('transfers on a type change', () => {
    const result = diff([entry('a', 'dir')], [entry('a', 'file', 5)]);
    expect(result.toTransfer.map((e) => e.path)).toEqual(['a']);
  });

  it('catches a symlink target change by size', () => {
    const result = diff([entry('l', 'symlink', 7)], [entry('l', 'symlink', 3)]);
    expect(result.toTransfer.map((e) => e.path)).toEqual(['l']);
  });

  it('skips remote-only entries without delete', () => {
    const result = diff([], [entry('gone.txt', 'file', 5)]);
    expect(result.toTransfer).toEqual([]);
    expect(result.deletes).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('deletes remote-only entries with delete', () => {
    const result = diff([], [entry('gone.txt', 'file', 5)], { delete: true });
    expect(result.deletes.map((e) => e.path)).toEqual(['gone.txt']);
    expect(result.skipped).toBe(0);
  });

  it('skips a remote error entry', () => {
    const result = diff(
      [entry('a.txt', 'file', 5)],
      [{ path: 'a.txt', type: 'file', size: 5, mode: '0644', mtime: '2026-10-27T10:00:00Z', error: 'permission denied' }],
    );
    // Cannot prove unchanged: an unreadable entry is not a transfer
    // candidate, it is skipped.
    expect(result.toTransfer).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('skips a remote other-type entry', () => {
    const result = diff([], [entry('dev', 'other')]);
    expect(result.skipped).toBe(1);
    expect(result.deletes).toEqual([]);
  });

  it('skips a local other-type entry', () => {
    const result = diff([entry('dev', 'other')], []);
    expect(result.toTransfer).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('never deletes an unarchivable pair', () => {
    // Both sides have an unarchivable entry at the same path: the source
    // cannot replace it, so the destination must keep it.
    const result = diff([entry('dev', 'other')], [entry('dev', 'other')], { delete: true });
    expect(result.deletes).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('hashes only files that match on size and mtime', () => {
    const same = entry('a.txt', 'file', 5);
    const localCalls: string[] = [];
    const remoteCalls: string[] = [];

    const result = diff(
      [same, entry('b.txt', 'file', 5, '2026-10-27T10:00:01Z')],
      [same, entry('b.txt', 'file', 5, '2026-10-27T10:00:00Z')],
      {
        localHash: (path) => {
          localCalls.push(path);
          return 'aa';
        },
        remoteHash: (path) => {
          remoteCalls.push(path);
          return 'aa';
        },
      },
    );
    expect(localCalls).toEqual(['a.txt']);
    expect(remoteCalls).toEqual(['a.txt']);
    // b.txt differs by mtime, so it transfers without any hashing.
    expect(result.toTransfer.map((e) => e.path)).toEqual(['b.txt']);
  });

  it('transfers on a checksum mismatch', () => {
    const same = entry('a.txt', 'file', 5);
    const result = diff([same], [same], { localHash: () => 'aa', remoteHash: () => 'bb' });
    expect(result.toTransfer.map((e) => e.path)).toEqual(['a.txt']);
  });

  it('skips when the remote hash is unprovable', () => {
    const same = entry('a.txt', 'file', 5);
    const result = diff([same], [same], { localHash: () => 'aa', remoteHash: () => null });
    expect(result.toTransfer).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('sums file sizes only into bytes', () => {
    const result = diff(
      [entry('a.txt', 'file', 5), entry('d', 'dir'), entry('l', 'symlink', 3)],
      [],
    );
    expect(result.bytes).toBe(5);
  });

  it('transfers on a directory mtime difference', () => {
    const result = diff(
      [entry('d', 'dir', 0, '2026-10-27T10:00:01Z')],
      [entry('d', 'dir', 0, '2026-10-27T10:00:00Z')],
    );
    expect(result.toTransfer.map((e) => e.path)).toEqual(['d']);
  });

  it('candidates are only the files a sha256 can settle', () => {
    const same = entry('a.txt', 'file', 5);
    const candidates = hashCandidates(
      [same, entry('b.txt', 'file', 5, '2026-10-27T10:00:01Z'), entry('d', 'dir'), entry('n.txt', 'file', 5)],
      [same, entry('b.txt', 'file', 5, '2026-10-27T10:00:00Z'), entry('d', 'dir')],
    );
    expect(candidates).toEqual(['a.txt']);
  });
});

describe('planBatches', () => {
  it('fills batches greedily within the part size', () => {
    const part = 100;
    const { batches, oversized } = planBatches(
      [entry('a', 'file', 60), entry('b', 'file', 40), entry('c', 'file', 10)],
      part,
    );
    expect(batches.map((b) => b.map((e) => e.path))).toEqual([['a', 'b'], ['c']]);
    expect(oversized).toEqual([]);
  });

  it('never splits a file across batches', () => {
    const { batches } = planBatches([entry('a', 'file', 60), entry('b', 'file', 50)], 100);
    expect(batches.map((b) => b.map((e) => e.path))).toEqual([['a'], ['b']]);
  });

  it('keeps a file equal to the part size in a batch', () => {
    const { batches, oversized } = planBatches([entry('a', 'file', 100)], 100);
    expect(oversized).toEqual([]);
    expect(batches).toHaveLength(1);
  });

  it('separates oversized files', () => {
    const { batches, oversized } = planBatches(
      [entry('big', 'file', 101), entry('a', 'file', 5)],
      100,
    );
    expect(oversized.map((e) => e.path)).toEqual(['big']);
    expect(batches.map((b) => b.map((e) => e.path))).toEqual([['a']]);
  });

  it('lets dirs and symlinks ride batches', () => {
    const { batches, oversized } = planBatches(
      [entry('a', 'file', 100), entry('d', 'dir'), entry('l', 'symlink')],
      100,
    );
    expect(oversized).toEqual([]);
    expect(batches.map((b) => b.map((e) => e.path))).toEqual([['a', 'd', 'l']]);
  });

  it('yields one batch for a set of only dirs', () => {
    const { batches } = planBatches([entry('d1', 'dir'), entry('d2', 'dir')], 100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('returns nothing for empty input', () => {
    const { batches, oversized } = planBatches([], 100);
    expect(batches).toEqual([]);
    expect(oversized).toEqual([]);
  });
});

describe('pruneDescendants', () => {
  it('drops descendants of a kept root', () => {
    expect(pruneDescendants(['a', 'a/b', 'a/b/c'])).toEqual(['a']);
  });

  it('prunes unsorted input to the topmost', () => {
    expect(pruneDescendants(['x/y', 'x', 'b', 'b/c', 'a'])).toEqual(['a', 'b', 'x']);
  });

  it('keeps paths without descendants unchanged', () => {
    expect(pruneDescendants(['b', 'a'])).toEqual(['a', 'b']);
  });
});

describe('relativeRemote', () => {
  it('keeps a relative path as-is', () => {
    expect(relativeRemote('src')).toBe('src');
  });

  it('normalizes a dot prefix', () => {
    expect(relativeRemote('./src')).toBe('src');
  });

  it('takes the basename of an absolute path, rsync-style', () => {
    expect(relativeRemote('/tmp/there/src')).toBe('src');
  });

  it('normalizes a trailing slash', () => {
    expect(relativeRemote('src/')).toBe('src');
  });
});

describe('remoteJoin and joinLocal', () => {
  it('joins remote paths like posixpath', () => {
    expect(remoteJoin('dst', 'a/b.txt')).toBe('dst/a/b.txt');
    expect(remoteJoin('.', 'a.txt')).toBe('./a.txt');
    expect(remoteJoin('', 'a.txt')).toBe('a.txt');
    expect(remoteJoin('/x', 'y')).toBe('/x/y');
  });

  it('joins local paths on the platform separator', () => {
    expect(joinLocal('root', 'a/b.txt')).toBe(join('root', 'a', 'b.txt'));
  });
});

describe('buildArchive and extractArchive', () => {
  /** The source tree every round-trip test uses. */
  async function tree(root: string): Promise<SyncEntry[]> {
    const a = await make(root, 'a.txt', 'hello');
    await chmod(a, 0o755);
    await utimes(a, 1774590000.123456789, 1774590000.123456789);
    await mkdir(join(root, 'sub'));
    await make(root, 'sub/b.bin');
    await writeFile(joinLocal(root, 'sub/b.bin'), new Uint8Array([0x00, 0xff]));
    await symlink('a.txt', join(root, 'link'));
    await mkdir(join(root, 'empty'));
    return walkLocal(root);
  }

  it('round-trips preserving bytes, modes, mtimes and links', async () => {
    await withTmpDir(async (root) => {
      const src = join(root, 'src');
      const dst = join(root, 'dst');
      const archive = join(root, 'batch.tgz');
      await mkdir(src);
      await mkdir(dst);
      const entries = await tree(src);

      await buildArchive(src, entries, archive);
      const extracted = await extractArchive(archive, dst);

      expect(extracted.sort()).toEqual(['a.txt', 'empty', 'link', 'sub', 'sub/b.bin']);
      expect(await readFile(join(dst, 'a.txt'), 'utf-8')).toBe('hello');
      expect((await stat(join(dst, 'a.txt'))).mode & 0o7777).toBe(0o755);
      expect(Math.floor((await stat(join(dst, 'a.txt'))).mtimeMs / 1000)).toBe(1774590000);
      expect(new Uint8Array(await readFile(join(dst, 'sub', 'b.bin')))).toEqual(new Uint8Array([0x00, 0xff]));
      expect((await lstat(join(dst, 'link'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(dst, 'link'), 'utf-8')).toBe('hello');
      expect((await stat(join(dst, 'empty'))).isDirectory()).toBe(true);
    });
  });

  it('archives the live bytes when a file changed after the walk', async () => {
    await withTmpDir(async (root) => {
      const src = join(root, 'src');
      const dst = join(root, 'dst');
      const archive = join(root, 'batch.tgz');
      await mkdir(src);
      await mkdir(dst);
      const entries = await tree(src);
      // The walk is done; the files change before the batch spools. The
      // header must describe the bytes the archive actually carries — a
      // stale walk-time size misaligns the padding and corrupts the batch.
      await writeFile(join(src, 'a.txt'), 'hello and then some'); // grew
      await writeFile(joinLocal(src, 'sub/b.bin'), new Uint8Array([0x42])); // shrank

      await buildArchive(src, entries, archive);
      const extracted = await extractArchive(archive, dst);

      expect(await readFile(join(dst, 'a.txt'), 'utf-8')).toBe('hello and then some');
      expect(new Uint8Array(await readFile(join(dst, 'sub', 'b.bin')))).toEqual(new Uint8Array([0x42]));
      // The members behind the changed files ride unharmed.
      expect(extracted.sort()).toEqual(['a.txt', 'empty', 'link', 'sub', 'sub/b.bin']);
      expect((await lstat(join(dst, 'link'))).isSymbolicLink()).toBe(true);
    });
  });

  it('refuses a file that outgrows its header mid-archive', async () => {
    await withTmpDir(async (root) => {
      const src = join(root, 'src');
      const archive = join(root, 'batch.tgz');
      await mkdir(src);
      // /dev/zero stats as 0 bytes but reads forever: the deterministic
      // stand-in for a file growing between the stat and the stream.
      await symlink('/dev/zero', join(src, 'zero'));
      const entries: SyncEntry[] = [
        { path: 'zero', type: 'file', size: 0, mode: '0644', mtime: formatMtime(0n) },
      ];

      await expect(buildArchive(src, entries, archive)).rejects.toThrow(/changed while it was archived/);
    });
  });

  it('extraction replaces members in the way', async () => {
    await withTmpDir(async (root) => {
      const src = join(root, 'src');
      const dst = join(root, 'dst');
      const archive = join(root, 'batch.tgz');
      await mkdir(src);
      await mkdir(dst);
      const entries = await tree(src);
      // Stale locals the extraction must replace.
      await writeFile(join(dst, 'a.txt'), 'stale-content');
      await writeFile(join(dst, 'sub'), 'a file where sub goes');

      await buildArchive(src, entries, archive);
      await extractArchive(archive, dst);

      expect(await readFile(join(dst, 'a.txt'), 'utf-8')).toBe('hello');
      expect((await stat(join(dst, 'sub'))).isDirectory());
    });
  });

  it('a file member replaces an in-the-way directory', async () => {
    await withTmpDir(async (root) => {
      const src = join(root, 'src');
      const dst = join(root, 'dst');
      const archive = join(root, 'batch.tgz');
      await mkdir(src);
      await mkdir(join(dst, 'flip'), { recursive: true });
      await make(dst, 'flip/child.txt');
      await make(src, 'flip');
      await writeFile(joinLocal(src, 'flip'), 'now a file');

      await buildArchive(src, await walkLocal(src), archive);
      await extractArchive(archive, dst);

      expect((await stat(join(dst, 'flip'))).isFile()).toBe(true);
      expect(await readFile(join(dst, 'flip'), 'utf-8')).toBe('now a file');
      // The in-the-way directory's child went with it.
      await expect(readFile(join(dst, 'flip', 'child.txt'))).rejects.toThrow();
    });
  });

  it('a dir member replaces an in-the-way file without following links in the way', async () => {
    await withTmpDir(async (root) => {
      const src = join(root, 'src');
      const dst = join(root, 'dst');
      const archive = join(root, 'batch.tgz');
      await mkdir(src);
      await mkdir(dst);
      await make(src, 'd/x.txt', 'in');
      // A symlink where the dir member lands: extraction replaces it, and
      // whatever it pointed at is untouched.
      await mkdir(join(dst, 'elsewhere'));
      await symlink('elsewhere', join(dst, 'd'));

      await buildArchive(src, await walkLocal(src), archive);
      await extractArchive(archive, dst);

      expect((await lstat(join(dst, 'd'))).isDirectory()).toBe(true);
      expect(await readFile(join(dst, 'd', 'x.txt'), 'utf-8')).toBe('in');
      expect(await readdir(join(dst, 'elsewhere')).then((r) => r)).toEqual([]);
    });
  });

  it('keep extracts only the changed set', async () => {
    await withTmpDir(async (root) => {
      const src = join(root, 'src');
      const dst = join(root, 'dst');
      const archive = join(root, 'batch.tgz');
      await mkdir(src);
      await mkdir(dst);
      const entries = await tree(src);
      await writeFile(join(dst, 'a.txt'), 'old-content');

      await buildArchive(src, entries, archive);
      const extracted = await extractArchive(archive, dst, new Set(['sub', 'sub/b.bin']));

      expect(extracted.sort()).toEqual(['sub', 'sub/b.bin']);
      expect(await readFile(join(dst, 'a.txt'), 'utf-8')).toBe('old-content');
      expect(new Uint8Array(await readFile(join(dst, 'sub', 'b.bin')))).toEqual(new Uint8Array([0x00, 0xff]));
    });
  });

  /** A raw tar of one member, gzipped — executor-shaped bytes for refusals. */
  async function rawArchive(root: string, name: string, content: string): Promise<string> {
    const archive = join(root, 'raw.tgz');
    const member: UstarMember = { name, type: 'file', mode: 0o644, mtime: 0, size: content.length };
    const padding = (BLOCK_SIZE - (content.length % BLOCK_SIZE)) % BLOCK_SIZE;
    const blocks = [...ustarHeaders(member), encoder.encode(content), new Uint8Array(padding), ustarTrailer()];
    const total = blocks.reduce((n, b) => n + b.length, 0);
    const tar = new Uint8Array(total);
    let at = 0;
    for (const block of blocks) {
      tar.set(block, at);
      at += block.length;
    }
    await pipeline(Readable.from([tar]), createGzip(), createWriteStream(archive));
    return archive;
  }

  it('refuses traversal members', async () => {
    await withTmpDir(async (root) => {
      const dst = join(root, 'dst');
      await mkdir(dst);
      const archive = await rawArchive(root, '../evil.txt', 'hi');
      await expect(extractArchive(archive, dst)).rejects.toThrow(/outside/i);
    });
  });

  it('normalizes inner .. members instead of refusing them', async () => {
    await withTmpDir(async (root) => {
      const dst = join(root, 'dst');
      await mkdir(dst);
      const archive = await rawArchive(root, 'a/../b.txt', 'hi');
      const extracted = await extractArchive(archive, dst);
      expect(extracted).toEqual(['b.txt']);
      expect(await readFile(join(dst, 'b.txt'), 'utf-8')).toBe('hi');
    });
  });

  it('refuses members whose .. chain escapes after normalization', async () => {
    await withTmpDir(async (root) => {
      const dst = join(root, 'dst');
      await mkdir(dst);
      const archive = await rawArchive(root, 'a/../../x.txt', 'hi');
      await expect(extractArchive(archive, dst)).rejects.toThrow(/outside/i);
    });
  });

  it('refuses absolute members', async () => {
    await withTmpDir(async (root) => {
      const dst = join(root, 'dst');
      await mkdir(dst);
      const archive = await rawArchive(root, '/etc/evil.txt', 'hi');
      await expect(extractArchive(archive, dst)).rejects.toThrow(/outside/i);
    });
  });
});

describe('SYNC_BATCH_BYTES', () => {
  it('is the multipart part size', () => {
    // Batches and upload parts share the 50 MiB budget: a file that
    // overflows a batch overflows a part, and rides multipart instead.
    expect(SYNC_BATCH_BYTES).toBe(50 * 1024 * 1024);
  });
});

