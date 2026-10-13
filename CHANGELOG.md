# Changelog

## Unreleased

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
