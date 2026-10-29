/**
 * The pure diff engine behind filesystem.sync().
 *
 * sync() is one-way like `rsync -r` without deltas: list both sides (a local
 * walk against GET /files/list NDJSON), diff on path/type/size/mtime
 * (+sha256 with checksum), and send the changed set as ~50 MiB tar batches
 * through /files/archive. This module holds the decisions — walking,
 * matching, diffing, planning, tar batches — with no executor I/O, so
 * every rule is testable against plain data and tmpdir trees.
 *
 * The wire shape on both sides is the executor's FileEntry: `path` (relative,
 * /-separated), `type` (file|dir|symlink|other), `size`, `mode` (4-digit
 * octal permission bits), `mtime` (RFC 3339 UTC with nanoseconds). Exclude
 * patterns follow the executor's archive-route semantics exactly — Go's
 * path.Match, tried against the relative path and every /-separated suffix
 * of it — so the local walk and the remote archive agree on what is in the
 * tree.
 *
 * Python parity: koyeb/sandbox/sync.py.
 */

import * as nodePath from 'node:path';

import {
  BLOCK_SIZE,
  UstarReader,
  ustarHeaders,
  ustarTrailer,
  type UstarMember,
} from './ustar.js';

/** One /files/list entry: what the executor streams and the walk emits. */
export type SyncEntry = {
  path: string;
  type: string;
  size: number;
  mode: string;
  mtime: string;
  error?: string;
};

/** What sync() must do with one pair of trees, before any transfer. */
export type SyncDiff = {
  /** Source entries (walk order) to copy. */
  toTransfer: SyncEntry[];
  /** Destination entries absent from the source. */
  deletes: SyncEntry[];
  /** Entries examined and left alone. */
  skipped: number;
  /** Content bytes to move. */
  bytes: number;
};

/** One tar batch's raw content budget: the multipart part size (50 MiB),
 *  comfortably inside the 100 MiB body cap with tar/gzip overhead on top. */
export const SYNC_BATCH_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Go path.Match parity
//
// The executor applies exclude patterns with Go's path.Match, where '*' and
// '?' never cross the '/' separator. A glob library is looser ('*' crosses
// '/'), so the semantics are ported faithfully; a malformed pattern throws
// the way the executor answers 400.

class BadPatternError extends Error {
  constructor() {
    super('bad exclude pattern');
  }
}

/** Whether the chunk starts with *, the chunk, and the rest. (Go scanChunk.)
 *
 *  The chunk ends at an unescaped '*' outside a character class; leading
 *  stars all collapse into the flag.
 */
function scanChunk(pattern: string): { star: boolean; chunk: string; rest: string } {
  let star = pattern.startsWith('*');
  while (pattern.startsWith('*')) {
    pattern = pattern.slice(1);
    star = true;
  }
  let inRange = false;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      // A bad trailing escape is matchChunk's error to report.
      if (i + 1 < pattern.length) i += 1;
    } else if (c === '[') {
      inRange = true;
    } else if (c === ']') {
      inRange = false;
    } else if (c === '*' && !inRange) {
      break;
    }
    i += 1;
  }
  return { star, chunk: pattern.slice(0, i), rest: pattern.slice(i) };
}

/** One class member: a literal, or a \-escaped character. (Go getEsc.) */
function getEsc(chunk: string): { member: string; rest: string } {
  if (chunk.length === 0 || chunk[0] === '-' || chunk[0] === ']') {
    throw new BadPatternError();
  }
  if (chunk[0] === '\\') {
    chunk = chunk.slice(1);
    if (chunk.length === 0) throw new BadPatternError();
  }
  return { member: chunk[0], rest: chunk.slice(1) };
}

/** One [...] class (chunk starts after the '[') against r. (Go's arm.)
 *
 *  Returns the rest of the chunk and whether the class matched; a malformed
 *  class throws, the way the executor answers 400.
 */
function matchClass(chunk: string, r: string): { chunk: string; matched: boolean } {
  let negated = chunk.startsWith('^');
  if (negated) chunk = chunk.slice(1);
  let matched = false;
  let nrange = 0;
  for (;;) {
    if (chunk.startsWith(']') && nrange > 0) {
      chunk = chunk.slice(1);
      break;
    }
    let lo: { member: string; rest: string } = getEsc(chunk);
    chunk = lo.rest;
    let hi = lo.member;
    if (chunk.startsWith('-')) {
      const esc = getEsc(chunk.slice(1));
      hi = esc.member;
      chunk = esc.rest;
    }
    if (lo.member <= r && r <= hi) matched = true;
    nrange += 1;
  }
  return { chunk, matched: matched !== negated };
}

/** One single-character unit against s[0]. (Go's matchChunk unit arm.) */
function matchUnit(c: string, chunk: string, s: string): { chunk: string; s: string; ok: boolean } {
  if (c === '?') {
    if (s[0] === '/') return { chunk, s, ok: false };
    return { chunk, s: s.slice(1), ok: true };
  }
  if (c === '\\') {
    if (chunk.length === 0) throw new BadPatternError();
    if (chunk[0] !== s[0]) return { chunk: chunk.slice(1), s, ok: false };
    return { chunk: chunk.slice(1), s: s.slice(1), ok: true };
  }
  if (c !== s[0]) return { chunk, s, ok: false };
  return { chunk, s: s.slice(1), ok: true };
}

/** Throw on a malformed remainder. (Go validates after any mismatch.) */
function validateChunk(chunk: string): void {
  let i = 0;
  while (i < chunk.length) {
    const c = chunk[i];
    i += 1;
    if (c === '\\') {
      if (i >= chunk.length) throw new BadPatternError();
      i += 1;
    } else if (c === '[') {
      const { chunk: rest } = matchClass(chunk.slice(i), '');
      i = chunk.length - rest.length;
    }
  }
}

/** Match one pattern chunk at the head of s. (Go matchChunk.)
 *
 *  Returns the rest of s and whether the chunk matched; throws on a
 *  malformed chunk. A chunk that cannot match — wrong literal, exhausted
 *  s — is still validated for the same errors a matching one would throw,
 *  exactly like Go's failed-flag protocol.
 */
function matchChunk(chunk: string, s: string): { s: string; ok: boolean } {
  let ok = true;
  while (chunk.length > 0 && s.length > 0 && ok) {
    const c = chunk[0];
    chunk = chunk.slice(1);
    if (c === '[') {
      const matched = matchClass(chunk, s[0]);
      chunk = matched.chunk;
      ok = matched.matched;
      if (ok) s = s.slice(1);
    } else {
      const unit = matchUnit(c, chunk, s);
      chunk = unit.chunk;
      s = unit.s;
      ok = unit.ok;
    }
  }
  if (chunk.length > 0) {
    validateChunk(chunk);
    return { s, ok: false };
  }
  return { s, ok };
}

/** Try the chunk at every skip point before a separator. (Go's star arm.)
 *
 *  Returns the advanced name on a match, null when none fits. A last chunk
 *  must exhaust the name — a longer rest keeps scanning.
 */
function starSkip(chunk: string, name: string, pattern: string): string | null {
  let i = 0;
  while (i < name.length && name[i] !== '/') {
    const matched = matchChunk(chunk, name.slice(i + 1));
    if (matched.ok && !(pattern.length === 0 && matched.s.length > 0)) {
      return matched.s;
    }
    i += 1;
  }
  return null;
}

/** Go's path.Match: '*', '?' and [...] never cross the '/' separator. */
export function pathMatch(pattern: string, name: string): boolean {
  while (pattern.length > 0) {
    const scanned = scanChunk(pattern);
    pattern = scanned.rest;
    const { star, chunk } = scanned;
    if (star && chunk.length === 0) {
      // A trailing * matches the rest unless it has a separator.
      return !name.includes('/');
    }
    const matched = matchChunk(chunk, name);
    if (matched.ok && (matched.s.length === 0 || pattern.length > 0)) {
      name = matched.s;
      continue;
    }
    if (star) {
      const advanced = starSkip(chunk, name, pattern);
      if (advanced !== null) {
        name = advanced;
        continue;
      }
    }
    // Before returning false, validate the rest of the pattern.
    while (pattern.length > 0) {
      const scannedRest = scanChunk(pattern);
      pattern = scannedRest.rest;
      matchChunk(scannedRest.chunk, '');
    }
    return false;
  }
  return name.length === 0;
}

/** The executor's exclude rule: pattern against rel and every suffix.
 *
 *  A directory that matches is pruned whole by the walker, so its
 *  descendants never reach this test — matching the archive route, which
 *  answers SkipDir at the same point.
 */
export function excluded(rel: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    let name = rel;
    for (;;) {
      if (pathMatch(pattern, name)) return true;
      const i = name.indexOf('/');
      if (i < 0) break;
      name = name.slice(i + 1);
    }
  }
  return false;
}

/** A path, or any directory prefix of it, matches a pattern.
 *
 *  The walker prunes a matching directory whole, so an entry under one is
 *  effectively excluded even when its own path does not match.
 */
export function pathExcluded(path: string, patterns: string[]): boolean {
  const parts = path.split('/');
  return parts.some((_, i) => excluded(parts.slice(0, i + 1).join('/'), patterns));
}

// ---------------------------------------------------------------------------
// mtime formatting
//
// The executor writes RFC 3339 with nanoseconds (RFC3339Nano, trailing zeros
// trimmed); the diff compares whole seconds, because tar's mtime cannot
// round-trip nanosecond precision — the same default as rsync.

/** Nanoseconds since the epoch as the executor formats mtime. */
export function formatMtime(ns: bigint): string {
  const seconds = ns / 1_000_000_000n;
  const nanos = ns % 1_000_000_000n;
  const date = new Date(Number(seconds) * 1000);
  const base = date.toISOString().slice(0, 19);
  if (nanos > 0n) {
    const frac = String(nanos).padStart(9, '0').replace(/0+$/, '');
    return `${base}.${frac}Z`;
  }
  return `${base}Z`;
}

/** An RFC 3339 mtime as whole seconds since the epoch (floored). */
export function mtimeSeconds(mtime: string): number {
  const base = mtime.replace(/Z$/, '').split('.')[0];
  const date = new Date(`${base}Z`);
  return Math.floor(date.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// local walk

/** A dirent's lstat classification, or null for unarchivable types. */
function classify(dirent: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): string | null {
  if (dirent.isFile()) return 'file';
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isSymbolicLink()) return 'symlink';
  return null; // devices, FIFOs, sockets: not archivable
}

/** A local tree as FileEntry-shaped entries, mirroring GET /files/list.
 *
 *  Paths are relative to root and /-separated; the root itself is not an
 *  entry. Symlinks are listed, not followed (like the executor's walk),
 *  special files are skipped, and an excluded directory is pruned whole.
 *  An unreadable subtree fails the walk — a silent drop would push a
 *  remotely-wrong tree.
 */
export async function walkLocal(root: string, exclude: string[] = []): Promise<SyncEntry[]> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const entries: SyncEntry[] = [];

  const relOf = (dirpath: string, name: string): string =>
    path.relative(root, path.join(dirpath, name)).split(path.sep).join('/');

  const visit = async (dirpath: string): Promise<void> => {
    const dirents = (await fsp.readdir(dirpath, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    const keptDirs: string[] = [];
    for (const dirent of dirents) {
      const rel = relOf(dirpath, dirent.name);
      const type = classify(dirent);
      if (type === null) continue; // special files skipped
      if (excluded(rel, exclude)) continue;
      if (type === 'dir') keptDirs.push(dirent.name);
      // BigInt stats: mtimeNs is exact to the nanosecond, and the epoch's ns
      // count overflows a double's 53-bit mantissa.
      const st = await fsp.lstat(path.join(dirpath, dirent.name), { bigint: true });
      entries.push({
        path: rel,
        type,
        size: Number(st.size),
        mode: Number(st.mode & 0o777n).toString(8).padStart(4, '0'),
        mtime: formatMtime(st.mtimeNs),
      });
    }
    // os.walk's order: each directory's entries (dirs first, sorted),
    // then its kept subdirectories in order.
    for (const name of keptDirs) {
      await visit(path.join(dirpath, name));
    }
  };

  await visit(root);
  return entries;
}

// ---------------------------------------------------------------------------
// diff

/** One pair's verdict before checksum: transfer, skip, or match. */
function pairKind(entry: SyncEntry, remoteEntry: SyncEntry): 'transfer' | 'skip' | 'match' {
  if (remoteEntry.error !== undefined || remoteEntry.type === 'other') return 'skip';
  if (changed(entry, remoteEntry)) return 'transfer';
  return 'match';
}

/** Entries by path. */
function indexEntries(entries: Iterable<SyncEntry>): Map<string, SyncEntry> {
  const map = new Map<string, SyncEntry>();
  for (const entry of entries) map.set(entry.path, entry);
  return map;
}

/** Whether a size-and-mtime-equal file's digests prove it changed.
 *
 *  A remote hash of null (vanished mid-sync, unreadable) proves nothing:
 *  not changed, not transferred.
 */
function hashVerdict(
  path: string,
  localHash: (path: string) => string | null,
  remoteHash: (path: string) => string | null,
): boolean {
  const remoteDigest = remoteHash(path);
  return remoteDigest !== null && remoteDigest !== localHash(path);
}

/** Delete candidates: entries the source lacks; unreadable ones never. */
function remainingDeletes(remote: Map<string, SyncEntry>): SyncEntry[] {
  return [...remote.values()].filter((entry) => entry.error === undefined);
}

/** Source-absent entries: delete candidates, or skips without delete. */
function settleRemaining(result: SyncDiff, remote: Map<string, SyncEntry>, doDelete: boolean): void {
  if (doDelete) {
    result.deletes = remainingDeletes(remote);
  } else {
    result.skipped += remote.size;
  }
}

/** Whether the pair differs on the diff's axes: type, size (files), whole-second mtime. */
function changed(localEntry: SyncEntry, remoteEntry: SyncEntry): boolean {
  if (localEntry.type !== remoteEntry.type) return true;
  // A directory's st_size is a filesystem-format artifact and can never
  // converge cross-filesystem; only real content carries size.
  if (localEntry.type !== 'dir' && localEntry.size !== remoteEntry.size) return true;
  if (mtimeSeconds(localEntry.mtime) !== mtimeSeconds(remoteEntry.mtime)) return true;
  return false;
}

function countTransfer(result: SyncDiff, entry: SyncEntry): void {
  result.toTransfer.push(entry);
  if (entry.type === 'file') result.bytes += entry.size;
}

/** Diff two FileEntry trees and plan a one-way copy.
 *
 *  The first argument is the SOURCE side (what diff copies from), the
 *  second the DESTINATION. An entry is unchanged when type, size and mtime
 *  (whole seconds) match on both sides. With hash callables, files that
 *  pass that test are compared by sha256 too (checksum=True); a remote
 *  hash of null can't prove a change and skips. Unreadable remote entries
 *  (the error field) and unarchivable types (other) are never transfer
 *  candidates.
 */
export function diff(
  localEntries: SyncEntry[],
  remoteEntries: SyncEntry[],
  options: {
    delete?: boolean;
    /** The SOURCE-side digest callable (diff's first argument's side). */
    localHash?: (path: string) => string | null;
    /** The DESTINATION-side digest callable; null proves nothing. */
    remoteHash?: (path: string) => string | null;
  } = {},
): SyncDiff {
  const { delete: doDelete = false, localHash, remoteHash } = options;
  const checksum = localHash !== undefined && remoteHash !== undefined;
  const result: SyncDiff = { toTransfer: [], deletes: [], skipped: 0, bytes: 0 };
  const remote = indexEntries(remoteEntries);

  for (const entry of localEntries) {
    if (entry.type === 'other') {
      // The source has something at this path it cannot send: the
      // destination keeps whatever it has there — an unarchivable pair
      // is skipped on both sides, never a delete candidate.
      remote.delete(entry.path);
      result.skipped += 1;
      continue;
    }
    const path = entry.path;
    const remoteEntry = remote.get(path) ?? null;
    if (remoteEntry === null) {
      countTransfer(result, entry);
      continue;
    }
    remote.delete(path);
    const kind = pairKind(entry, remoteEntry);
    if (kind === 'transfer') {
      countTransfer(result, entry);
    } else if (kind === 'match' && checksum && entry.type === 'file') {
      if (hashVerdict(path, localHash, remoteHash)) {
        countTransfer(result, entry);
      } else {
        result.skipped += 1;
      }
    } else {
      result.skipped += 1;
    }
  }
  settleRemaining(result, remote, doDelete);
  return result;
}

/** Paths that only a sha256 comparison can settle.
 *
 *  Files present on both sides, matching on type, size and mtime: the
 *  candidates checksum=True must hash. The caller prefetches the
 *  executor-side digests for these in one pass (the pure, synchronous
 *  diff cannot await).
 */
export function hashCandidates(sourceEntries: SyncEntry[], destEntries: SyncEntry[]): string[] {
  const dest = indexEntries(destEntries);
  const candidates: string[] = [];
  for (const entry of sourceEntries) {
    const other = dest.get(entry.path);
    if (
      other !== undefined &&
      entry.type === 'file' &&
      other.type === 'file' &&
      !changed(entry, other)
    ) {
      candidates.push(entry.path);
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// batch planning

/** Cut the changed set into tar batches and oversized files.
 *
 *  Batches accumulate raw file content up to partSize (~50 MiB): a file
 *  that would cross the boundary starts the next batch, so no file is ever
 *  split across archives. Files larger than one part go through
 *  upload_file/download_file instead. Directories and symlinks ride the
 *  next batch (their wire size is a header); a set of only those still
 *  produces one batch.
 */
export function planBatches(
  entries: SyncEntry[],
  partSize: number,
): { batches: SyncEntry[][]; oversized: SyncEntry[] } {
  const batches: SyncEntry[][] = [];
  const oversized: SyncEntry[] = [];
  let current: SyncEntry[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const size = entry.size;
    if (entry.type === 'file' && size > partSize) {
      oversized.push(entry);
      continue;
    }
    if (current.length > 0 && currentBytes + size > partSize) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return { batches, oversized };
}

// ---------------------------------------------------------------------------
// deletes and the remote default

/** A remote path for a relative entry path (remote paths are POSIX). */
export function remoteJoin(remote: string, rel: string): string {
  if (rel.startsWith('/')) return rel;
  if (remote === '') return rel;
  return `${remote}/${rel}`;
}

/** A local path for a relative entry path, on any platform. */
export function joinLocal(root: string, rel: string): string {
  return nodePath.join(root, ...rel.split('/'));
}

/** Topmost paths only: deleting a directory takes its descendants.
 *
 *  Input order is irrelevant; the result is sorted. A descendant of a kept
 *  path is already covered by its parent's recursive delete, and deleting
 *  it separately would just miss (it is already gone).
 */
export function pruneDescendants(paths: string[]): string[] {
  const kept: string[] = [];
  for (const path of [...paths].sort()) {
    if (kept.length > 0 && path.startsWith(`${kept[kept.length - 1]}/`)) continue;
    kept.push(path);
  }
  return kept;
}

/** The remote path used when remote is undefined: local's relative form.
 *
 *  A relative local path is kept as-is (resolved by the executor against
 *  the sandbox workdir); an absolute one contributes its basename,
 *  rsync-style.
 */
export function relativeRemote(local: string): string {
  let normalized = nodePath.normalize(local);
  if (nodePath.isAbsolute(normalized)) {
    normalized = nodePath.basename(normalized);
  }
  // Node's normalize keeps a trailing slash; posixpath strips it.
  normalized = normalized.replace(/\/+$/, '') || (nodePath.isAbsolute(local) ? '/' : '.');
  return normalized.split(nodePath.sep).join('/');
}

// ---------------------------------------------------------------------------
// tar batches
//
// A batch is built spooled to disk, then streamed into PUT /files/archive
// (constant memory, bounded disk: one batch ~ part size). Whole-second
// mtimes are exactly what the diff compares. Owners are not kept
// (uid/gid 0), per the design.

/** One SyncEntry as the tar member the archive carries. */
function tarMember(entry: SyncEntry, linkname: string | undefined): UstarMember {
  return {
    name: entry.path,
    type: entry.type === 'dir' ? 'dir' : entry.type === 'symlink' ? 'symlink' : 'file',
    mode: Number.parseInt(entry.mode, 8),
    mtime: mtimeSeconds(entry.mtime),
    size: entry.type === 'file' ? entry.size : 0,
    ...(entry.type === 'symlink' ? { linkname: linkname ?? '' } : {}),
  };
}

/** Write the changed entries as a gzip'd tar spooled to dest.
 *
 *  Members mirror the executor's archive: paths relative and
 *  /-separated, modes and whole-second mtimes kept, symlinks as links.
 */
export async function buildArchive(root: string, entries: SyncEntry[], dest: string): Promise<void> {
  const { createReadStream, createWriteStream } = await import('node:fs');
  const { createGzip } = await import('node:zlib');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const fsp = await import('node:fs/promises');

  const blocks = async function* (): AsyncGenerator<Uint8Array, void, unknown> {
    for (const entry of entries) {
      const linkname = entry.type === 'symlink' ? await fsp.readlink(joinLocal(root, entry.path)) : undefined;
      let member = tarMember(entry, linkname);
      if (member.type === 'file') {
        // The walk's size can be stale by spool time; a header that does
        // not describe the carried bytes misaligns the padding and the batch.
        member = { ...member, size: (await fsp.stat(joinLocal(root, entry.path))).size };
      }
      yield* ustarHeaders(member);
      if (member.type === 'file') {
        let sent = 0;
        for await (const chunk of createReadStream(joinLocal(root, entry.path))) {
          // A concurrent writer cannot be allowed to overflow the header's
          // size; extra bytes would desynchronize the next member.
          const take = chunk as Buffer;
          const room = member.size - sent;
          if (take.length > room) {
            yield take.subarray(0, room);
            sent = member.size;
            break;
          }
          yield take;
          sent += take.length;
          if (sent === member.size) break;
        }
        if (sent < member.size) {
          throw new Error(`file changed while it was archived: ${entry.path}`);
        }
        const padding = (BLOCK_SIZE - (member.size % BLOCK_SIZE)) % BLOCK_SIZE;
        if (padding > 0) yield new Uint8Array(padding);
      }
    }
    yield ustarTrailer();
  };

  await pipeline(Readable.from(blocks()), createGzip(), createWriteStream(dest));
}

/** A member path safe to write under the destination, or a refusal.
 *
 *  The same refusal the executor applies to archives it extracts:
 *  absolute paths and .. escapes never touch the filesystem.
 */
function cleanMemberName(name: string): string {
  const absolute = name.startsWith('/');
  const out: string[] = [];
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
        continue;
      }
      if (absolute) continue;
      out.push('..');
      continue;
    }
    out.push(part);
  }
  let normalized = out.join('/');
  if (absolute) normalized = `/${normalized}`;
  if (normalized === '') normalized = absolute ? '/' : '.';
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`refusing archive member outside destination: ${JSON.stringify(name)}`);
  }
  return normalized;
}

/** Make room for a member: replace whatever sits at its path. */
async function clearMember(path: string): Promise<void> {
  const fsp = await import('node:fs/promises');
  const st = await fsp.lstat(path).catch(() => null);
  if (st === null) return;
  if (st.isDirectory()) {
    await fsp.rm(path, { recursive: true, force: true });
    return;
  }
  await fsp.unlink(path);
}

/** Stream one regular member to path, then keep its mode and mtime. */
async function extractFile(
  reader: UstarReader,
  member: { mode: number; mtime: number; size: number },
  path: string,
): Promise<void> {
  const fsp = await import('node:fs/promises');
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');

  await clearMember(path);
  await fsp.mkdir(nodePath.dirname(path), { recursive: true });
  const out = createWriteStream(path);
  await pipeline(Readable.from(reader.content()), out);
  const mtime = Math.trunc(member.mtime);
  await fsp.utimes(path, mtime, mtime);
  await fsp.chmod(path, member.mode & 0o7777);
}

/** Extract one member at path; returns its kind (dir|sym|file|skip). */
async function extractMember(
  reader: UstarReader,
  member: { name: string; typeflag: string; mode: number; mtime: number; size: number; linkname: string },
  path: string,
): Promise<'dir' | 'sym' | 'file' | 'skip'> {
  const fsp = await import('node:fs/promises');

  if (member.typeflag === '5') {
    const st = await fsp.lstat(path).catch(() => null);
    // A file or link in the way would make mkdir follow it or fail; the
    // member replaces it without following.
    if (st !== null && !st.isDirectory()) {
      await fsp.unlink(path);
    }
    await fsp.mkdir(path, { recursive: true });
    return 'dir';
  }
  if (member.typeflag === '2') {
    await clearMember(path);
    await fsp.mkdir(nodePath.dirname(path), { recursive: true });
    await fsp.symlink(member.linkname, path);
    return 'sym';
  }
  if (member.typeflag === '0' || member.typeflag === '\0') {
    await extractFile(reader, member, path);
    return 'file';
  }
  await reader.drain();
  return 'skip';
}

/** Extract a spooled archive into dest, mirroring the executor.
 *
 *  Missing parents are created; members in the way are replaced; directory
 *  modes and mtimes are applied after the contents (writing into a
 *  directory bumps its mtime, and a restrictive mode applied early would
 *  lock the contents out). With keep, only those members are extracted —
 *  the pull side's changed set. Returns the member paths extracted.
 */
export async function extractArchive(
  archivePath: string,
  dest: string,
  keep?: Set<string>,
): Promise<string[]> {
  const { createReadStream } = await import('node:fs');
  const { createGunzip } = await import('node:zlib');

  const source = createReadStream(archivePath);
  const gunzip = createGunzip();
  source.pipe(gunzip);
  const reader = new UstarReader(gunzip);

  const extracted: string[] = [];
  const dirs: Array<{ path: string; mode: number; mtime: number }> = [];
  try {
    for (;;) {
      const member = await reader.next();
      if (member === null) break;
      const name = cleanMemberName(member.name);
      if (keep !== undefined && !keep.has(name)) {
        await reader.drain();
        continue;
      }
      const path = joinLocal(dest, name);
      const kind = await extractMember(reader, member, path);
      if (kind === 'skip') continue;
      if (kind === 'dir') {
        dirs.push({ path, mode: member.mode, mtime: member.mtime });
      }
      extracted.push(name);
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }

  // Directory modes and mtimes last, deepest first, like the executor.
  const fsp = await import('node:fs/promises');
  for (const dir of dirs.sort((a, b) => (a.path > b.path ? -1 : a.path < b.path ? 1 : 0))) {
    const mtime = Math.trunc(dir.mtime);
    await fsp.utimes(dir.path, mtime, mtime);
    await fsp.chmod(dir.path, dir.mode & 0o7777);
  }
  return extracted;
}
