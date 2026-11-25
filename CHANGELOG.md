# Changelog

## Unreleased

### Sidecars stay in step with their sandbox

Like the Python SDK's sidecar lifecycle: a sandbox created with sidecars gets `KOYEB_SIDECARS`
on its env — its sidecars' names and ports as JSON (nothing secret) — which code inside the
sandbox can read and `get_from_id` uses to find the sidecars again, matched by exact name among
the sandbox's app services (no extra API call for sandboxes without sidecars). The name is
reserved: passing `KOYEB_SIDECARS` in `env` raises, even without sidecars. A damaged value, a
failed lookup or a missing sidecar raises `SidecarError` instead of returning a partial list.

Sidecars expire with their sandbox: `delete_after_delay` is counted from each service's own
creation and sidecars are created first, so their delay is extended by the gap — at create
(best effort: a failure only logs) and in `update_lifecycle`, which updates the sidecars first,
as life-cycle-only updates (`update_mask` on `life_cycle.delete_after_create`, no redeploy),
skipping those already set, then the sandbox. It reads the sidecars from the live deployment,
so handles from `list()` are covered too; a failed sidecar update changes nothing on the sandbox
(`SidecarError` lists the sidecars).

`delete_after_inactivity_delay` is rejected with sidecars, at create and in `update_lifecycle`:
sidecars never sleep, so the sandbox would be deleted and its sidecars left running.
`update_network_policy` also checks the live deployment, so a `list()` handle can't cut a sandbox
off from its sidecars either.

### `sidecars` on `Sandbox.create`

Like the Python SDK's `Sandbox.create(sidecars=...)`: `Sandbox.create({ sidecars })` takes a
list of `Sidecar` objects, created first in the sandbox's app (with its region and its
`delete_after_delay`/`delete_after_inactivity_delay`, and the service name set). When `wait_ready`
is on (the default), the sandbox is created only once every sidecar is healthy, i.e. its first
port accepts TCP connections; the sidecar wait and the sandbox readiness wait share one `timeout`
deadline. The sandbox's mesh is forced on with app scope, so the mesh is private to the sandbox and
its sidecars, which it reaches at `http://<name>:<port>`.

A sidecar that fails or never becomes healthy raises `SidecarError` (`SidecarTimeoutError` on a
timeout, which is also a `SandboxTimeoutError`), says which sidecar, what happened to the app —
deleted, kept for inspection with `cleanup_on_failure: false`, or failed to delete — and the app
the call created is (best-effort) cleaned up. Conflicting arguments (`app_id`, `snapshot`,
`block_network`, `outbound_allowlist`, `enable_mesh: false`, another `mesh_scope`, duplicate names)
fail before any API call. `update_network_policy` rejects `block_network` and
`outbound_allowlist` on a sandbox with sidecars: they also block the mesh.

`sandbox.sidecars` and `sandbox.sidecar(name)` return `SidecarInfo` (name, `service_id`, frozen
ports, `url(port?, scheme)`). Backward compatible: `sidecars` defaults to none and create sends the
same requests as before.

### `Sidecar`: a helper service that runs next to the sandbox

Like the Python SDK's `Sidecar`: a trusted helper service with its own image, env,
secrets and egress policy that runs next to a sandbox, which reaches it by name over a
private mesh (`http://<name>:<port>`). Secrets given to a sidecar never enter the sandbox.
`new Sidecar({ name, image, ports })` is validated at construction and `validateSidecars()` checks
a set: unique names, none equal to the sandbox's. A sidecar is built as a WEB service with no
routes (not public), tcp ports, a TCP health check on its first port (`startup_grace_period`,
5-900 s), the mesh enabled with app scope, its own optional egress policy (`block_network`,
`outbound_allowlist`) and no scale-to-zero. VPN-style sidecars can run `privileged`.
`Sandbox.create({ sidecars })` runs them next to a sandbox (see the `sidecars` entry above).

### `mesh_scope` on `Sandbox.create`

Like `mesh_scope` in the Python SDK: `Sandbox.create({ mesh_scope })` takes
`MESH_SCOPE_APP`, `MESH_SCOPE_WORKSPACE` or `MESH_SCOPE_ORGANIZATION` and sends it as
`network_policy.mesh.scope`, next to any egress policy. A scope turns the mesh on.
`MESH_SCOPE_CUSTOM` (which needs a mesh name), unknown values, `enable_mesh: false`, free
instances and full snapshots are rejected before any API call. Without `mesh_scope`, create
sends the same definition as before.

`update_network_policy()` now keeps the sandbox's mesh scope: it used to replace the whole
network policy, which silently moved the sandbox back to the default mesh.

### `KOYEB_SANDBOX_GATEWAY_URL` overrides the sandbox gateway

Like `KOYEB_SANDBOX_GATEWAY_URL` in the Python SDK (1.6.0): when set, every executor
call (exec, files, health) goes to that gateway instead of the `public_url` the API
returns, for example `http://sandbox-gateway.<namespace>.svc` for clients inside a
self-hosted cluster. The routing key and sandbox secret still come from the deployment
metadata. `get_domain()` keeps the public URL.

### Same-name creates in the same millisecond no longer collide

`Sandbox.create()` names the app it creates `sandbox-app-<name>-<suffix>`. The suffix
was the millisecond timestamp, and app names are unique per organization, so two
creates with the same name in the same millisecond (parallel creates, or two processes
in one organization) failed with 400 "name already exists". The suffix is now the
timestamp in base 36 plus 5 random characters: still 13 characters, so every name that
fit the 64-character app name limit still fits.

### Readiness waits poll faster near readiness

- `wait_ready()` (and `Sandbox.create()`) checks every 0.1 s for the first 10 s of the
  wait, then backs off up to `poll_interval` as before. It sees a sandbox turn healthy
  ~0.1 s after it happens, instead of up to 0.5 s later.
- `wait_claim_ready()` backs off 0.1 → 0.2 → 0.4 → 0.5 s instead of polling every 2 s:
  `DEFAULT_CLAIM_POLL_INTERVAL` goes from 2 to 0.5, and a `poll_interval` you pass caps
  the backoff.
- Both send more status requests per wait: a create ready in ~4 s makes ~28 API requests
  instead of ~10, a claim that starts its sandbox ~14 instead of ~7.

### `get_from_id` right after create no longer raises `NoSandboxSecretError`

Until a new service marks its deployment active, a moment after the deployment turns
healthy, the API returns `active_deployment_id` as `""`. `get_from_id` kept that empty
id instead of falling back to `latest_deployment_id`, and raised `NoSandboxSecretError`
without reading any deployment: about 1 call in 20 made just after `Sandbox.create()`.
An empty id now counts as unset there, in the readiness wait of a handle without a
pinned deployment, and in `get_tcp_proxy_info()`. Python parity (`active or latest`).

### Streaming `exec` retries a refused connect, as `stream: false` does

`exec()` (streaming by default) and `exec_stream()` now send the command again when the
connection fails before the request leaves (refused, unreachable, DNS), with the buffered
route's backoff: 1, 2, 4 s, 3 retries. Nothing is retried once a response has come back
(a 5xx, or a stream cut mid-way, may come after the command ran), after an abort, or when
the next backoff would end past the command's `timeout`. A reset connection is not
retried either: the executor may already have read the request. Python parity
(koyeb-python-sdk#111).

- ⚠️ A streaming `exec` to an endpoint that keeps refusing connections now fails after
  ~7 s of retries instead of at once (or at its `timeout`, if shorter)

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
touching either side; a no-op sync sends nothing beyond the listing. A pull never writes
outside the local directory: a path that leaves it, or that goes through a symlink, fails
the sync. Requires executor v0.0.24+.

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
