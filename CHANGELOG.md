# Changelog

## Unreleased

### Directory sync + snapshot copy on the archive routes (ST-137)

`filesystem.sync(localPath, remotePath?, options)` mirrors a directory between the local
machine and the sandbox, one way — `rsync -r` without deltas. Both sides are listed (a
local walk against the executor's NDJSON `GET /files/list`) and diffed on path, type,
size and whole-second mtime; `checksum: true` adds a sha256 comparison. The changed set
travels as ~50 MiB gzip'd tar batches through `PUT /files/archive` (spooled per batch,
flat memory) — a pull streams `GET /files/archive` and extracts only the changed set.
Files larger than one batch ride the multipart `upload_file` / resumable `download_file`
(ST-136). `delete: true` prunes destination extras topmost-first via the legacy routes;
`exclude` follows the executor's `tar --exclude` semantics; `dry_run` computes without
touching either side; a no-op sync sends nothing beyond the listing. Requires executor
v0.0.24+.

```ts
const result = await sandbox.filesystem.sync('./site', 'site', {
  direction: 'push',
  delete: true,
  exclude: ['node_modules'],
});
// { uploaded: 42, deleted: 3, skipped: 117, bytes: 1_048_576 }
```

- New executor-route transports on the Sandbox surface beside the fs operations:
  `filesList(path, { recursive, signal })` (NDJSON, one entry per line, error entries
  pass through), `filesArchiveGet(path, { exclude, signal })` (streamed gzip'd tar),
  `filesArchivePut(path, content, { signal })` (→ `{ files, bytes }`, never retried —
  a consumed stream cannot replay), and `filesStat` grows `hash: 'sha256'`
- `DeclarativeSnapshot.copy()` of a directory now travels as **one archive push**
  (`filesystem.sync`) on executors v0.0.24+ — binary-safe, modes/mtimes/symlinks kept;
  the legacy walk read files as **text** and lost all three. Single files ride the
  streamed `upload_file`. Old executors keep the per-file legacy walk, byte-for-byte
- The tar batches ride a minimal in-house ustar writer (`src/ustar.ts`): POSIX ustar
  headers with prefix-split long names, GNU `L`/`K` extensions beyond, PAX-aware
  reader for the executor's Go archives. The SDK keeps **zero runtime dependencies**
  (gzip is `node:zlib`)
- Python parity: `koyeb/koyeb-python-sdk` PR #107 (`files-sync`) — same engine rules
  (whole-second mtimes, unarchivable pairs never deleted, excluded directories pruned
  whole, already-gone deletes tolerated and counted, oversized files' bytes never
  travel twice). Divergences: an invalid `direction` raises `SandboxFilesystemError`
  (Python: `ValueError`), and the options are one object with an `AbortSignal` seam
  (Python has no cancellation)

### ⚠️ Breaking change: `read_file` returns the content (ST-135, KOYEB-6699)

`read_file(path, { encoding })` now returns the file content directly — a `string` for
`'utf-8'` (the default) and `'base64'`, a `Uint8Array` for `encoding: null` (the raw
disk bytes). Previously it returned the executor's `{ content, encoding }` reply object.

```ts
// Before
const info = await sandbox.filesystem.read_file('/data/x'); // { content: 'hello', encoding: 'utf-8' }

// After
const text = await sandbox.filesystem.read_file('/data/x'); // 'hello'
const bytes = await sandbox.filesystem.read_file('/data.bin', { encoding: null }); // Uint8Array
```

### Streamed binary-safe file I/O on the `/files` routes, with legacy fallback (ST-135, KOYEB-6699)

On executors v0.0.24+ the byte-moving filesystem operations run on the executor's
streamed `/files` routes — binary-safe, constant memory, real bytes on disk for every
content type. Older executors are detected automatically (one body-less
`GET /files/stat` probe per sandbox handle, one cached warning) and keep the legacy
JSON routes.

- `write_file(path, content, { mode, signal })` accepts `string | Uint8Array | Blob |
  `ReadableStream` | Node streams; the optional `mode` is an octal string like `'0644'`
  (streamed routes only; legacy keeps the destination's mode)
- `read_stream(path)` — async iterator of chunks; `stat(path)` — `{ type, size, mode,
  mtime, sha256? }` (new routes only; raises on legacy executors)
- `upload_file` / `download_file` transfer in one streamed request (`fetch` with
  `duplex: 'half'`): the upload verifies content end to end with `X-Content-SHA256`, the
  download streams into `<local>.part` then renames into place. Both honor an
  `AbortSignal` mid-flight and report `progress(done, total)` at most every 100 ms.
  Transfers are bounded by a 60 s **idle** timeout instead of a total timeout: a slow
  transfer that keeps moving is never cut off
- On legacy (pre-v0.0.24) executors, binary content rides the **base64 transport** so it
  round-trips byte-exact through this SDK: `write_file` with `Uint8Array` encodes it,
  `read_file`/`download_file` with `encoding: 'base64'` decode it. Text transfers keep
  the historical behavior (default `'utf-8'`); streams and Blobs raise and name v0.0.24
- Streaming routes use a new non-retrying request path on the executor gateway — a
  streamed body cannot be replayed — while every JSON route keeps its retries unchanged

### ⚠️ Breaking change: `download_file` argument order (KOYEB-6568)

`download_file` now takes `(remotePath, localPath)` — read remote first, write local
second — matching the Python SDK (`download_file(remote_path, local_path)`) and the
CLI (`koyeb sandbox fs download <sandbox> <remote_path> <local_path>`). Previously this
SDK took `(localPath, remotePath)`, the opposite of every other Koyeb client, so code
ported from Python or the CLI silently wrote to the wrong path. Two string arguments
cannot be disambiguated at runtime, so this is a hard signature swap.

Migration:

```ts
// Before
await sandbox.filesystem.download_file(localPath, remotePath);

// After — same argument order as Python and the CLI
await sandbox.filesystem.download_file(remotePath, localPath);
```

`upload_file(localPath, remotePath)` is unchanged and matches the Python SDK. Both
transfers read their arguments in the direction of the transfer:

```ts
await sandbox.filesystem.upload_file(localPath, remotePath);   // local  → remote
await sandbox.filesystem.download_file(remotePath, localPath); // remote → local
```

**Release vehicle:** recommended **semver-major (`2.0.0`)** — a silent hard swap must
not reach `^1.1.0` consumers through a minor bump. Alternative: accept in `1.2.0` with
this loud changelog entry if adoption is confirmed to be near-zero; the final call is
flagged in the pull request.

### Multipart uploads + resumable downloads for files larger than one request (ST-136, KOYEB-6700)

A file larger than `part_size` no longer needs a proxy body big enough to carry it:
`upload_file` opens an offset-addressed session on the executor (v0.0.24+) and sends
it as parts. Downloads resume after a network error instead of starting over.

- `upload_file(localPath, remotePath, { part_size?, concurrency?, … })` — default
  50 MiB parts (capped by the executor's `max_part_size`, 100 MiB), 4 parts in flight,
  each read from disk at its offset per attempt, per-part sha256, whole-file sha256
  verified at complete. Memory holds `part_size × concurrency`
- Retry per part, never per body: transient network errors retry a part alone (the
  bytes are replayable; the executor overwrites the same bytes). A part that times out
  or hits Cloudflare's 524 splits in half, recursively down to a 1 MiB floor — a
  smaller part needs less time on the wire
- Resume without re-sending: `complete` reports the missing ranges in its 409 and the
  flow fills exactly those; a lost session (executor restart, 1 h idle expiry)
  surfaces as a clean "restart the upload" error, never corruption. Every failure
  aborts its session, and the abort never masks the cause
- `download_file(remotePath, localPath)` resumes by default: after a network error
  the remaining bytes are fetched with `Range` + `If-Range` on the executor's strong
  ETag — received bytes are never re-sent; a file that changed under us restarts the
  `.part` from scratch. Attempts that make no net progress back off and surface
  after 3 retries; a transfer that keeps moving keeps going — a file without a
  validator cannot keep what landed, so its restarts spend the same budget
  instead of looping forever
