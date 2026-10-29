import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  SandboxFilesystem,
  ProgressReporter,
  type FileStat,
  type SandboxPort,
} from './sandbox-filesystem.js';
import {
  SandboxFileExistsError,
  SandboxFileNotFoundError,
  SandboxFilesystemError,
  SandboxRequestError,
} from './errors.js';

/**
 * Filesystem-layer tests for the streamed /files routes (executor v0.0.24+)
 * and the legacy JSON fallback, against a fake executor port. Python parity:
 * koyeb/sandbox/test_filesystem.py — the case set mirrors it.
 */

type Overrides = {
  hasFilesRoutes?: boolean;
  request?: unknown;
  filesPut?: unknown;
  filesRead?: unknown;
  filesStat?: unknown;
};

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Consume whatever content shape the fs layer handed to files_put. */
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
    for await (const chunk of content as AsyncIterable<Uint8Array>) chunks.push(chunk);
  }
  return concatBytes(chunks);
}

/** The fake port's mock surface, so tests can configure replies and read calls. */
type FakePort = {
  calls: unknown[][];
  exec: Mock;
  request: Mock;
  hasFilesRoutes: Mock;
  filesPut: Mock;
  filesRead: Mock;
  filesStat: Mock;
};

/**
 * Executor-port fake mirroring the Python suite's _FakeSyncClient: per-method
 * canned replies or exceptions, every call recorded. hasFilesRoutes defaults
 * to false so legacy-behavior tests stay on the JSON routes.
 */
function fakePort(overrides: Overrides = {}): FakePort {
  const calls: unknown[][] = [];
  const port: FakePort = {
    calls,
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    request: vi.fn(async (path: string, _init: RequestInit, body?: unknown) => {
      calls.push(['request', path, body]);
      const reply = overrides.request;
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    }),
    hasFilesRoutes: vi.fn(async () => overrides.hasFilesRoutes ?? false),
    filesPut: vi.fn(async (path: string, content: unknown, options?: Record<string, unknown>) => {
      const joined = await joinContent(content);
      calls.push(['files_put', path, joined, options?.mode, options?.sha256]);
      const reply = overrides.filesPut;
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    }),
    filesRead: vi.fn(async function* (path: string, _options?: unknown) {
      calls.push(['files_read', path]);
      const reply = overrides.filesRead;
      if (reply instanceof Error) throw reply;
      yield* (Array.isArray(reply) ? reply : [reply ?? new Uint8Array(0)]) as Uint8Array[];
    }),
    filesStat: vi.fn(async (path: string) => {
      calls.push(['files_stat', path]);
      const reply = overrides.filesStat;
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    }),
  };
  return port;
}

/** The filesystem under test, wired to a fake port. */
function fsOf(port: FakePort): SandboxFilesystem {
  return new SandboxFilesystem(port as unknown as SandboxPort);
}

function lastCall(port: FakePort, method: string): unknown[] {
  for (const call of [...port.calls].reverse()) {
    if (call[0] === method) return call;
  }
  throw new Error(`no ${method} call recorded`);
}

function fs(overrides: Overrides = {}) {
  return fsOf(fakePort(overrides));
}

const encoder = new TextEncoder();
const sha256 = (data: Uint8Array | string) =>
  createHash('sha256').update(typeof data === 'string' ? encoder.encode(data) : data).digest('hex');

async function tempFile(data: Uint8Array | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'st135-'));
  const path = join(dir, 'local.bin');
  await writeFile(path, data);
  return path;
}

function statusError(status: number, body: string) {
  return new SandboxRequestError(status, body);
}

describe('write_file on the new routes', () => {
  it('sends Uint8Array content raw: real bytes on disk', async () => {
    const port = fakePort({ hasFilesRoutes: true });
    await fsOf(port).write_file('/a.bin', new Uint8Array([0x00, 0xff, 0xfe]));

    const [method, path, content, mode] = lastCall(port, 'files_put');
    expect(method).toBe('files_put');
    expect(path).toBe('/a.bin');
    expect(content).toEqual(new Uint8Array([0x00, 0xff, 0xfe]));
    expect(mode).toBeUndefined();
  });

  it('encodes string content as UTF-8 bytes', async () => {
    const port = fakePort({ hasFilesRoutes: true });
    await fsOf(port).write_file('/a.txt', 'héllo');

    const [, , content] = lastCall(port, 'files_put');
    expect(content).toEqual(encoder.encode('héllo'));
  });

  it('streams Blob content as real bytes', async () => {
    const port = fakePort({ hasFilesRoutes: true });
    await fsOf(port).write_file('/a.bin', new Blob([new Uint8Array([0x00, 0x01])]));

    const [, , content] = lastCall(port, 'files_put');
    expect(content).toEqual(new Uint8Array([0x00, 0x01]));
  });

  it('streams web ReadableStream content chunk by chunk', async () => {
    const port = fakePort({ hasFilesRoutes: true });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('ab'));
        controller.enqueue(encoder.encode('cdef'));
        controller.close();
      },
    });
    await fsOf(port).write_file('/a', stream);

    const [method, path, content] = lastCall(port, 'files_put');
    expect(method).toBe('files_put');
    expect(path).toBe('/a');
    expect(content).toEqual(encoder.encode('abcdef'));
  });

  it('streams Node Readable content chunk by chunk', async () => {
    const port = fakePort({ hasFilesRoutes: true });
    await fsOf(port).write_file('/a', Readable.from([encoder.encode('ab'), encoder.encode('cdef')]));

    const [, , content] = lastCall(port, 'files_put');
    expect(content).toEqual(encoder.encode('abcdef'));
  });

  it('forwards the mode option', async () => {
    const port = fakePort({ hasFilesRoutes: true });
    await fsOf(port).write_file('/a.sh', 'x', { mode: '0755' });

    const [, , , mode] = lastCall(port, 'files_put');
    expect(mode).toBe('0755');
  });

  it('classifies 404 as not found', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesPut: statusError(404, '{"error": "file does not exist"}'),
    });

    const error = await filesystem.write_file('/missing', new Uint8Array([1])).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFileNotFoundError);
    expect((error as Error).message).toBe('File not found: /missing');
  });

  it('classifies 409 as exists, carrying the executor message', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesPut: statusError(409, '{"error": "destination is a directory"}'),
    });

    const error = await filesystem.write_file('/isdir', new Uint8Array([1])).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFileExistsError);
    expect((error as Error).message).toBe('destination is a directory');
  });

  it('classifies 409 from a parsed JSON body: the post/parse shape', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesPut: new SandboxRequestError(409, { error: 'destination is a directory' }),
    });

    const error = await filesystem.write_file('/isdir', new Uint8Array([1])).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFileExistsError);
    expect((error as Error).message).toBe('destination is a directory');
  });

  it('falls back to the default when a JSON body carries no error text', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesPut: new SandboxRequestError(409, { error: { code: 5 } }),
    });

    const error = await filesystem.write_file('/isdir', new Uint8Array([1])).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFileExistsError);
    expect((error as Error).message).toBe('Conflict at: /isdir');
  });

  it('carries the executor message on a generic status', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesPut: statusError(400, '{"error": "sha256 mismatch: got a, expected b"}'),
    });

    await expect(filesystem.write_file('/a', new Uint8Array([1]))).rejects.toThrow(
      'Failed to write file: sha256 mismatch: got a, expected b',
    );
  });
});

describe('write_file on the legacy routes', () => {
  it('writes string content as-is', async () => {
    const port = fakePort();
    await fsOf(port).write_file('/a', 'hello');

    const [method, path, body] = lastCall(port, 'request');
    expect(method).toBe('request');
    expect(path).toBe('/write_file');
    expect(body).toEqual({ path: '/a', content: 'hello' });
  });

  it('writes Uint8Array content through the base64 transport', async () => {
    const port = fakePort();
    await fsOf(port).write_file('/b', new Uint8Array([0x00, 0x01]));

    const [, , body] = lastCall(port, 'request');
    expect(body).toEqual({ path: '/b', content: Buffer.from([0x00, 0x01]).toString('base64') });
  });

  it('stays generic on executor errors: Python classifies none for write_file', async () => {
    const port = fakePort({ request: { error: 'no such file or directory' } });
    const rejection = expect(fsOf(port).write_file('/a', 'x')).rejects;
    await rejection.toBeInstanceOf(SandboxFilesystemError);
    await rejection.not.toBeInstanceOf(SandboxFileNotFoundError);
    await rejection.not.toBeInstanceOf(SandboxFileExistsError);
  });

  it('wraps unexpected transport failures', async () => {
    const port = fakePort({ request: new Error('boom') });
    const error = await fsOf(port).write_file('/a', 'x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFilesystemError);
    expect((error as Error).message).toContain('boom');
  });

  it('rethrows a classified error from the base64 transport as-is', async () => {
    const port = fakePort({ request: new SandboxFilesystemError('classified already') });
    const error = await fsOf(port).write_file('/a', new Uint8Array([1])).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFilesystemError);
    expect((error as Error).message).toBe('classified already');
  });

  it('raises a clear error for stream content: legacy cannot carry it', async () => {
    const filesystem = fs({ hasFilesRoutes: false });
    const error = await filesystem.write_file('/a', Readable.from([encoder.encode('ab')])).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFilesystemError);
    expect((error as Error).message).toContain('v0.0.24');
  });
});

describe('read_file on the new routes', () => {
  it('returns the raw bytes with encoding null', async () => {
    const filesystem = fs({ hasFilesRoutes: true, filesRead: [new Uint8Array([0x00, 0xff, 0xfe])] });
    const content = await filesystem.read_file('/a.bin', { encoding: null });

    expect(content).toEqual(new Uint8Array([0x00, 0xff, 0xfe]));
  });

  it('decodes UTF-8 by default', async () => {
    const filesystem = fs({ hasFilesRoutes: true, filesRead: [encoder.encode('héllo')] });
    const content = await filesystem.read_file('/a.txt');

    expect(content).toBe('héllo');
  });

  it('encodes the real bytes as base64 with encoding base64', async () => {
    const filesystem = fs({ hasFilesRoutes: true, filesRead: [new Uint8Array([0x00, 0x01])] });
    const content = await filesystem.read_file('/a.bin', { encoding: 'base64' });

    expect(content).toBe(Buffer.from([0x00, 0x01]).toString('base64'));
  });

  it('classifies 404 as not found', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesRead: statusError(404, '{"error": "file does not exist"}'),
    });

    await expect(filesystem.read_file('/missing')).rejects.toThrow('File not found: /missing');
  });
});

describe('read_file on the legacy routes', () => {
  it('returns the content text by default', async () => {
    const port = fakePort({ request: { content: 'hello' } });
    await expect(fsOf(port).read_file('/a')).resolves.toBe('hello');
  });

  it('keeps the legacy base64 decode semantics: content is decoded, not transported', async () => {
    const encoded = Buffer.from([0x00, 0x01]).toString('base64');
    const port = fakePort({ request: { content: encoded } });

    const content = await fsOf(port).read_file('/a', { encoding: 'base64' });

    expect(content).toEqual(new Uint8Array([0x00, 0x01]));
  });

  it('raises a clear error for encoding null: legacy cannot return raw bytes', async () => {
    const filesystem = fs({ request: { content: 'hi' } });
    const error = await filesystem.read_file('/a', { encoding: null }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFilesystemError);
    expect((error as Error).message).toContain('v0.0.24');
  });

  it('classifies the legacy not-found reply', async () => {
    const port = fakePort({ request: { error: 'open /a: no such file or directory' } });
    await expect(fsOf(port).read_file('/a')).rejects.toBeInstanceOf(SandboxFileNotFoundError);
  });

  it('wraps unexpected transport failures', async () => {
    const port = fakePort({ request: new Error('boom') });
    const error = await fsOf(port).read_file('/a').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFilesystemError);
    expect((error as Error).message).toContain('boom');
  });

  it('refuses a malformed reply instead of reading it as empty', async () => {
    const port = fakePort({ request: { nope: true } });
    const error = await fsOf(port).read_file('/a').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFilesystemError);
    expect((error as Error).message).toContain('malformed /read_file reply');
  });

  it('classifies a transport not-found message through the catch', async () => {
    const port = fakePort({ request: new Error('open /a: no such file or directory') });
    const error = await fsOf(port).read_file('/a').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFileNotFoundError);
    expect((error as Error).message).toBe('File not found: /a');
  });
});

describe('read_file decoding', () => {
  it('refuses invalid UTF-8 instead of corrupting it', async () => {
    const filesystem = fs({ hasFilesRoutes: true, filesRead: [new Uint8Array([0xff, 0xfe, 0xfd])] });

    const error = await filesystem.read_file('/garbage.txt').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFilesystemError);
    expect((error as Error).message).toContain('Failed to read file');
  });
});

describe('ls', () => {
  it('lists like list_dir: the Python short spelling', async () => {
    const port = fakePort({ request: { entries: ['a', 'b'] } });

    await expect(fsOf(port).ls()).resolves.toEqual(['a', 'b']);

    const [, path] = lastCall(port, 'request');
    expect(path).toBe('/list_dir');
  });
});

describe('write_files', () => {
  it('writes every entry through write_file', async () => {
    const port = fakePort();
    await fsOf(port).write_files([
      { path: '/a', content: 'x' },
      { path: '/b', content: 'y' },
    ]);

    const writes = port.calls.filter((call) => call[0] === 'request');
    expect(writes).toHaveLength(2);
    expect(writes.map((call) => (call[2] as { path: string }).path).sort()).toEqual(['/a', '/b']);
  });
});

describe('read_stream', () => {
  it('yields the streamed chunks on the new routes', async () => {
    const filesystem = fs({ hasFilesRoutes: true, filesRead: [new Uint8Array([0x00, 0xff])] });
    const chunks: Uint8Array[] = [];
    for await (const chunk of filesystem.read_stream('/a.bin')) chunks.push(chunk);

    expect(concatBytes(chunks)).toEqual(new Uint8Array([0x00, 0xff]));
  });

  it('classifies a 404 mid-stream', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesRead: statusError(404, '{"error": "file does not exist"}'),
    });

    const error = await filesystem.read_stream('/gone').next().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxFileNotFoundError);
  });

  it('yields the legacy text read as one chunk of UTF-8 bytes', async () => {
    const filesystem = fs({ request: { content: 'hello' } });
    const chunks: Uint8Array[] = [];
    for await (const chunk of filesystem.read_stream('/a')) chunks.push(chunk);

    expect(chunks).toEqual([encoder.encode('hello')]);
  });
});

describe('stat', () => {
  const entry = {
    type: 'file',
    size: 7,
    mode: '0644',
    mtime: '2026-10-27T10:00:00.123456789Z',
  };

  it('returns the FileStat from the stat entry', async () => {
    const filesystem = fs({ hasFilesRoutes: true, filesStat: entry });
    const stat: FileStat = await filesystem.stat('/a.txt');

    expect(stat).toEqual({ ...entry, sha256: undefined });
    expect(stat.sha256).toBeUndefined();
  });

  it('carries sha256 when the executor reports it', async () => {
    const filesystem = fs({ hasFilesRoutes: true, filesStat: { ...entry, sha256: 'abc' } });
    expect(await filesystem.stat('/a.txt')).toMatchObject({ sha256: 'abc' });
  });

  it('classifies 404 as not found', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesStat: statusError(404, '{"error": "file does not exist"}'),
    });

    await expect(filesystem.stat('/missing')).rejects.toBeInstanceOf(SandboxFileNotFoundError);
  });

  it('raises a clear error on legacy executors', async () => {
    const filesystem = fs({ hasFilesRoutes: false });
    const error = await filesystem.stat('/a.txt').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFilesystemError);
    expect((error as Error).message).toContain('v0.0.24');
  });

  it('fails fast on a malformed stat reply', async () => {
    const filesystem = fs({ hasFilesRoutes: true, filesStat: { size: 5 } });
    const error = await filesystem.stat('/a').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFilesystemError);
    expect((error as Error).message).toContain('Failed to stat file');
  });
});

describe('upload_file on the new routes', () => {
  it('streams the local bytes raw and sends the content digest', async () => {
    const data = new Uint8Array(256 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const digest = sha256(data);
    const port = fakePort({ hasFilesRoutes: true, filesPut: { size: data.length, sha256: digest } });
    const local = await tempFile(data);

    try {
      await fsOf(port).upload_file(local, '/remote.bin');
    } finally {
      await rm(local, { force: true });
    }

    const [method, path, content, , sentSha] = lastCall(port, 'files_put');
    expect(method).toBe('files_put');
    expect(path).toBe('/remote.bin');
    expect(content).toEqual(data);
    expect(sentSha).toBe(digest);
    // Constant memory: the body handed to the transport is a stream, not a buffer.
    expect(port.filesPut.mock.calls[0][1]).toBeInstanceOf(ReadableStream);
  });

  it('raises on a digest mismatch in the executor reply', async () => {
    const port = fakePort({ hasFilesRoutes: true, filesPut: { size: 3, sha256: 'deadbeef' } });
    const local = await tempFile('abc');

    try {
      const error = await fsOf(port).upload_file(local, '/r.bin').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toContain('corrupt');
    } finally {
      await rm(local, { force: true });
    }
  });

  it('raises not found for a missing local file', async () => {
    const filesystem = fs({ hasFilesRoutes: true });
    const error = await filesystem.upload_file('/nonexistent/local', '/r.bin').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFileNotFoundError);
    expect((error as Error).message).toContain('Local file not found');
  });

  it('reports progress at most every 100ms, with a guaranteed final call', async () => {
    const data = new Uint8Array(256 * 1024);
    const digest = sha256(data);
    const port = fakePort({ hasFilesRoutes: true, filesPut: { size: data.length, sha256: digest } });
    const local = await tempFile(data);
    const calls: Array<[number, number]> = [];

    try {
      await fsOf(port).upload_file(local, '/remote.bin', {
        progress: (done, total) => calls.push([done, total]),
      });
    } finally {
      await rm(local, { force: true });
    }

    expect(calls[calls.length - 1]).toEqual([data.length, data.length]);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it('honors an abort signal mid-flight', async () => {
    vi.useFakeTimers();
    const port = fakePort({ hasFilesRoutes: true });
    // A files_put that hangs until the caller aborts (like the real transport,
    // which honors an already-aborted signal too).
    port.filesPut.mockImplementation(
      (_path: string, _content: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort);
        }),
    );
    const local = await tempFile('abc');
    const controller = new AbortController();

    const pending = fsOf(port).upload_file(local, '/r.bin', { signal: controller.signal });
    const errorPromise = pending.catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 500);
    await vi.advanceTimersByTimeAsync(500);
    const error = await errorPromise;

    expect((error as Error).name).toBe('AbortError');
    await rm(local, { force: true });
  });
});

describe('download_file on the new routes', () => {
  const data = new Uint8Array(200);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

  it('stats, streams into .part and renames into place', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesRead: [data],
      filesStat: { type: 'file', size: data.length, mode: '0644', mtime: '2026-10-27T10:00:00Z' },
    });
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const target = join(dir, 'out.bin');

    try {
      await filesystem.download_file('/remote.bin', target);
      expect(new Uint8Array(await readFile(target))).toEqual(data);
      expect(existsSync(`${target}.part`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed stat reply through the shared stat contract', async () => {
    const filesystem = fs({ hasFilesRoutes: true, filesStat: { size: 5 }, filesRead: [new Uint8Array(5)] });
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const target = join(dir, 'out.bin');

    try {
      const error = await filesystem.download_file('/a', target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toContain('malformed /files/stat reply');
      expect(existsSync(`${target}.part`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('classifies a stat 404 and leaves no .part', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesStat: statusError(404, '{"error": "file does not exist"}'),
    });
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const target = join(dir, 'out.bin');

    try {
      const error = await filesystem.download_file('/missing', target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxFileNotFoundError);
      expect(existsSync(`${target}.part`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cleans the .part when the transfer fails mid-stream', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesRead: statusError(404, '{"error": "file does not exist"}'),
      filesStat: { type: 'file', size: 4, mode: '0644', mtime: '2026-10-27T10:00:00Z' },
    });
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const target = join(dir, 'out.bin');

    try {
      const error = await filesystem.download_file('/gone', target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxFileNotFoundError);
      expect(existsSync(`${target}.part`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports progress with exact totals', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesRead: [data],
      filesStat: { type: 'file', size: data.length, mode: '0644', mtime: '2026-10-27T10:00:00Z' },
    });
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const target = join(dir, 'out.bin');
    const calls: Array<[number, number]> = [];

    try {
      await filesystem.download_file('/r.bin', target, { progress: (done, total) => calls.push([done, total]) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls[calls.length - 1]).toEqual([data.length, data.length]);
  });

  it('fails fast when the stat reply has no size', async () => {
    const filesystem = fs({
      hasFilesRoutes: true,
      filesRead: [new Uint8Array([1])],
      filesStat: { type: 'file' },
    });
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const target = join(dir, 'out.bin');

    try {
      const error = await filesystem.download_file('/r', target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toContain('Failed to download file');
      expect(existsSync(`${target}.part`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy error classification per operation', () => {
  // Python's _executor_error matrix: only the classes each operation can
  // produce classify. write_file is generic-only; read/list/delete
  // classify not-found only; mkdir classifies exists only.
  it('read_file keeps not-found but not exists', async () => {
    const port = fakePort({ request: { error: 'file already exists' } });
    const rejection = expect(fsOf(port).read_file('/a')).rejects;
    await rejection.toBeInstanceOf(SandboxFilesystemError);
    await rejection.not.toBeInstanceOf(SandboxFileExistsError);
  });

  it('mkdir classifies exists only: a missing parent stays generic', async () => {
    const port = fakePort({ request: { error: 'mkdir: no such file or directory' } });
    const rejection = expect(fsOf(port).mkdir('/a/b')).rejects;
    await rejection.toBeInstanceOf(SandboxFilesystemError);
    await rejection.not.toBeInstanceOf(SandboxFileNotFoundError);
  });

  it('mkdir still classifies directory-exists', async () => {
    const port = fakePort({ request: { error: 'directory already exists' } });
    await expect(fsOf(port).mkdir('/a')).rejects.toBeInstanceOf(SandboxFileExistsError);
  });

  it('list_dir keeps not-found but not exists', async () => {
    const port = fakePort({ request: { error: 'directory already exists' } });
    const rejection = expect(fsOf(port).list_dir('/a')).rejects;
    await rejection.toBeInstanceOf(SandboxFilesystemError);
    await rejection.not.toBeInstanceOf(SandboxFileExistsError);
  });

  it('delete_file keeps not-found but not exists', async () => {
    const port = fakePort({ request: { error: 'file exists' } });
    const rejection = expect(fsOf(port).delete_file('/a')).rejects;
    await rejection.toBeInstanceOf(SandboxFilesystemError);
    await rejection.not.toBeInstanceOf(SandboxFileExistsError);
  });

  it('delete_dir keeps not-found but not exists', async () => {
    const port = fakePort({ request: { error: 'directory exists' } });
    const rejection = expect(fsOf(port).delete_dir('/a')).rejects;
    await rejection.toBeInstanceOf(SandboxFilesystemError);
    await rejection.not.toBeInstanceOf(SandboxFileExistsError);
  });

  it('mkdir wraps a transport failure as a filesystem error', async () => {
    const port = fakePort({ request: new Error('socket hang up') });
    await expect(fsOf(port).mkdir('/a')).rejects.toThrow('Failed to create directory: socket hang up');
  });

  it('mkdir classifies an exists message from the transport, like the reply arm', async () => {
    const port = fakePort({ request: new Error('mkdir: /a: file exists') });
    const rejection = expect(fsOf(port).mkdir('/a')).rejects;
    await rejection.toBeInstanceOf(SandboxFileExistsError);
    await rejection.toThrow('Directory already exists: /a');
  });

  it("threads the caller's signal into the legacy write", async () => {
    const port = fakePort();
    let seen: AbortSignal | undefined;
    port.request.mockImplementationOnce(async (_path: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return {};
    });
    const controller = new AbortController();

    await fsOf(port).write_file('/a', 'x', { signal: controller.signal });

    expect(seen).toBe(controller.signal);
  });

  it("threads the caller's signal into the legacy upload write", async () => {
    const port = fakePort();
    let seen: AbortSignal | undefined;
    port.request.mockImplementationOnce(async (_path: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return {};
    });
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const local = join(dir, 'up.txt');
    await writeFile(local, 'hello');
    const controller = new AbortController();

    try {
      await fsOf(port).upload_file(local, '/remote.txt', { signal: controller.signal });
      expect(seen).toBe(controller.signal);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('list_dir wraps a transport failure and classifies its not-found message', async () => {
    const port = fakePort({ request: new Error('open /a: no such file or directory') });
    await expect(fsOf(port).list_dir('/a')).rejects.toThrow('Directory not found: /a');
  });

  it('delete_file wraps a transport failure and classifies its not-found message', async () => {
    const port = fakePort({ request: new Error('remove /a: no such file or directory') });
    const rejection = expect(fsOf(port).delete_file('/a')).rejects;
    await rejection.toBeInstanceOf(SandboxFileNotFoundError);
    await rejection.toThrow('File not found: /a');
  });

  it('delete_dir wraps a transport failure as a filesystem error', async () => {
    const port = fakePort({ request: new Error('socket hang up') });
    await expect(fsOf(port).delete_dir('/a')).rejects.toThrow('Failed to delete directory: socket hang up');
  });
});

describe('transfers on the legacy routes', () => {
  it("refuses an already-aborted signal on the legacy download", async () => {
    const port = fakePort({ request: { content: 'hello' } });
    const controller = new AbortController();
    controller.abort();
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const target = join(dir, 'out.txt');

    try {
      const error = await fsOf(port).download_file('/r', target, { signal: controller.signal }).catch((e: unknown) => e);

      expect((error as Error).name).toBe('AbortError');
      expect(existsSync(target)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips binary through the base64 transport: byte-exact', async () => {
    const data = new Uint8Array([0x00, 0xff, 0xfe, 0x7f, 0x80]);
    const b64 = Buffer.from(data).toString('base64');
    const port = fakePort({ request: { content: b64 } });
    const filesystem = fsOf(port);
    const local = await tempFile(data);
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const target = join(dir, 'out.bin');

    try {
      await filesystem.upload_file(local, '/remote.bin', { encoding: 'base64' });
      // The write rode the base64 transport: the wire content is the encoding.
      const [, , writeBody] = lastCall(port, 'request');
      expect(writeBody).toEqual({ path: '/remote.bin', content: b64 });

      await filesystem.download_file('/remote.bin', target, { encoding: 'base64' });
      expect(new Uint8Array(await readFile(target))).toEqual(data);
    } finally {
      await rm(local, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the historical text behavior for legacy transfers by default', async () => {
    const port = fakePort({ request: { content: 'hello' } });
    const filesystem = fsOf(port);
    const local = await tempFile('hello');
    const dir = await mkdtemp(join(tmpdir(), 'st135-'));
    const target = join(dir, 'out.bin');

    try {
      await filesystem.upload_file(local, '/remote.txt');
      const [, , writeBody] = lastCall(port, 'request');
      expect(writeBody).toEqual({ path: '/remote.txt', content: 'hello' });

      await filesystem.download_file('/remote.txt', target);
      expect(await readFile(target, 'utf-8')).toBe('hello');
    } finally {
      await rm(local, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the fix when the default text transport cannot carry the local file', async () => {
    const port = fakePort({});
    const filesystem = fsOf(port);
    const local = await tempFile(new Uint8Array([0x00, 0xff, 0xfe]));

    try {
      const error = await filesystem.upload_file(local, '/remote.bin').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toContain('base64');
    } finally {
      await rm(local, { force: true });
    }
  });

  it('raises not found for a missing local file', async () => {
    const filesystem = fs({});
    const error = await filesystem.upload_file('/nonexistent/local', '/r.bin').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxFileNotFoundError);
  });
});

describe('the legacy fallback dispatch', () => {
  it('warns once per handle through the shared probe', async () => {
    // The probe caching lives on the gateway (transport tests pin the single
    // probe); here we pin the dispatch: legacy ports never see files calls.
    const port = fakePort({ request: { content: 'x' } });
    const filesystem = fsOf(port);

    await filesystem.read_file('/a');
    await filesystem.read_file('/b');
    await filesystem.write_file('/c', 'x');

    expect(port.hasFilesRoutes).toHaveBeenCalledTimes(3);
    expect(port.filesPut).not.toHaveBeenCalled();
    expect(port.filesRead).not.toHaveBeenCalled();
    expect(port.filesStat).not.toHaveBeenCalled();
  });

  it('routes every file operation through the new routes when the probe says so', async () => {
    const port = fakePort({ hasFilesRoutes: true, filesRead: [encoder.encode('x')] });
    const filesystem = fsOf(port);

    await filesystem.read_file('/a');
    await filesystem.write_file('/b', 'x');

    expect(port.filesRead).toHaveBeenCalled();
    expect(port.filesPut).toHaveBeenCalled();
    expect(port.request).not.toHaveBeenCalled();
  });
});

describe('ProgressReporter', () => {
  it('throttles to one call per 100ms and always fires the final call', () => {
    const calls: Array<[number, number]> = [];
    const reporter = new ProgressReporter((done, total) => calls.push([done, total]), 100);
    const clock = vi.spyOn(performance, 'now');

    clock.mockReturnValue(100);
    reporter.update(10); // 100 - 0 >= 100: fires on the boundary
    clock.mockReturnValue(150);
    reporter.update(20); // 150 - 100 < 100: suppressed
    clock.mockReturnValue(260);
    reporter.update(30); // 260 - 100 >= 100: fires
    reporter.finish(100); // always fires, whatever the throttle saw

    expect(calls).toEqual([
      [10, 100],
      [30, 100],
      [100, 100],
    ]);
  });

  it('is a no-op without a progress callback', () => {
    const reporter = new ProgressReporter(undefined, 100);
    reporter.update(10);
    reporter.finish(100);
  });

  it('fires the first update regardless of the process age', () => {
    const calls: Array<[number, number]> = [];
    const reporter = new ProgressReporter((done, total) => calls.push([done, total]), 100);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(50); // 50 ms after process start

    reporter.update(10);

    clock.mockRestore();
    expect(calls).toEqual([[10, 100]]);
  });

  it('throttles on the monotonic clock, immune to wall-clock steps', async () => {
    // An NTP hold or step can freeze or jump Date.now(); progress must not.
    const frozenWallClock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const calls: Array<[number, number]> = [];
    const reporter = new ProgressReporter((done, total) => calls.push([done, total]), 100);

    reporter.update(10);
    await new Promise((resolve) => setTimeout(resolve, 120));
    reporter.update(20);

    frozenWallClock.mockRestore();
    expect(calls).toEqual([
      [10, 100],
      [20, 100],
    ]);
  });
});
