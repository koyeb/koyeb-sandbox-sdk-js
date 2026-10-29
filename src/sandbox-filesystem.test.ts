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
  SandboxServiceError,
  SandboxTimeoutError,
} from './errors.js';
import { UPLOAD_CONCURRENCY, UPLOAD_PART_SIZE } from './constants.js';

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
  /** One entry per filesReadRange call, consumed in order (the resume script). */
  filesReadRange?: RangeAttempt[];
};

/** One scripted GET /files reply: chunks yield, then failWith throws mid-stream. */
type RangeAttempt = {
  status?: number;
  etag?: string;
  chunks?: Uint8Array[];
  failWith?: unknown;
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
  filesReadRange: Mock;
  filesUploadOpen: Mock;
  filesUploadPart: Mock;
  filesUploadStatus: Mock;
  filesUploadComplete: Mock;
  filesUploadAbort: Mock;
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
    // The ranged seam download_file rides; scripted attempts come from the
    // filesReadRange override, the default serves the filesRead override
    // (chunks array or Error) as a 200 with a fixed etag.
    filesReadRange: vi.fn(async (path: string, options?: { range?: string; ifRange?: string }) => {
      calls.push(['files_read_range', path, options?.range, options?.ifRange]);
      const scripted = overrides.filesReadRange;
      if (Array.isArray(scripted)) {
        const attempt = scripted.shift() ?? { status: 200, chunks: [] };
        return {
          status: attempt.status ?? 200,
          etag: attempt.etag,
          stream: (async function* () {
            for (const chunk of attempt.chunks ?? []) yield chunk;
            if (attempt.failWith !== undefined) throw attempt.failWith;
          })(),
        };
      }
      const reply = overrides.filesRead;
      if (reply instanceof Error) throw reply;
      const chunks = (Array.isArray(reply) ? reply : [reply ?? new Uint8Array(0)]) as Uint8Array[];
      return {
        status: 200,
        etag: '"fake-etag"',
        stream: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
      };
    }),
    filesUploadOpen: vi.fn(async (path: string, size: number) => {
      calls.push(['open', path, size]);
      return { upload_id: 'u-1', max_part_size: 1 << 30 };
    }),
    filesUploadPart: vi.fn(async (uploadId: string, offset: number) => {
      calls.push(['part', uploadId, offset]);
    }),
    filesUploadStatus: vi.fn(async (uploadId: string) => {
      calls.push(['status', uploadId]);
      return { size: 0, ranges: [] };
    }),
    filesUploadComplete: vi.fn(async () => {
      calls.push(['complete']);
      return { size: 0 };
    }),
    filesUploadAbort: vi.fn(async () => {
      calls.push(['abort']);
    }),
  };
  return port;
}

/** Multipart session faults the fs layer must recover from (Python parity:
 *  _UploadFakeExecutor's fail_parts / forget_parts / never_record knobs). */
type UploadFakeOptions = {
  maxPartSize?: number;
  /** `${offset}:${length}` → the error thrown once on that part attempt. */
  failParts?: Record<string, unknown>;
  /** Offsets whose first span lands but is forgotten — complete's 409 fill. */
  forgetParts?: number[];
  /** Offsets whose spans are never recorded — the no-progress liar. */
  neverRecord?: number[];
  /** A canned open reply; the session is not created when it is given. */
  openReply?: Record<string, unknown>;
  lieAboutSha?: string;
  raw409Body?: string;
  abortError?: boolean;
  onPart?: (options: { signal?: AbortSignal }) => void | Promise<void>;
  omitCompleteSha?: boolean;
};

/**
 * Stateful fake for the multipart session flow, mirroring the Python suite's
 * _UploadFakeExecutor: parts land at offsets into a pre-sized buffer, complete
 * answers 409 with the true missing ranges until coverage holds, then verifies
 * the whole-file digest the way the executor does. Records every call in
 * `calls` exactly like fakePort does, so lastCall() readouts work on both.
 */
function uploadFake(options: UploadFakeOptions = {}) {
  const maxPartSize = options.maxPartSize ?? 1 << 30;
  const failParts = new Map(Object.entries(options.failParts ?? {}));
  const forgetParts = new Set(options.forgetParts ?? []);
  const neverRecord = new Set(options.neverRecord ?? []);
  const calls: unknown[][] = [];
  let session: { size: number; want: string | undefined; data: Uint8Array; spans: Array<[number, number]> } | null =
    null;
  let inFlight = 0;
  let maxInFlight = 0;

  // The executor's addSpan: merge every overlapping-or-adjacent span into the
  // new one, keep the rest, sort.
  const record = (start: number, end: number) => {
    if (session === null) return;
    let ns = start;
    let ne = end;
    const out: Array<[number, number]> = [];
    for (const [s, e] of session.spans) {
      if (e >= ns && ne >= s) {
        ns = Math.min(ns, s);
        ne = Math.max(ne, e);
        continue;
      }
      out.push([s, e]);
    }
    out.push([ns, ne]);
    out.sort((a, b) => a[0] - b[0]);
    session.spans = out;
  };

  // The executor's missingSpans: the parts of [0, size) no span covers.
  const missing = (): Array<[number, number]> => {
    if (session === null) return [];
    let at = 0;
    const out: Array<[number, number]> = [];
    for (const [s, e] of session.spans) {
      if (s > at) out.push([at, s]);
      at = Math.max(at, e);
    }
    if (at < session.size) out.push([at, session.size]);
    return out;
  };

  const port: FakePort = {
    calls,
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    request: vi.fn(async () => ({})),
    hasFilesRoutes: vi.fn(async () => true),
    filesStat: vi.fn(async (path: string) => {
      calls.push(['files_stat', path]);
      return { type: 'file', size: 12, mode: '0644', mtime: '2026-01-01T00:00:00Z' };
    }),
    filesPut: vi.fn(async (path: string, content: unknown, o?: Record<string, unknown>) => {
      const joined = await joinContent(content);
      calls.push(['files_put', path, joined, o?.sha256]);
      return { size: joined.byteLength, sha256: sha256(joined) };
    }),
    filesRead: vi.fn(async function* (path: string) {
      calls.push(['files_read', path]);
      yield encoder.encode('remote-bytes');
    }),
    filesReadRange: vi.fn(async (path: string, o?: { range?: string; ifRange?: string }) => {
      calls.push(['files_read_range', path, o?.range, o?.ifRange]);
      return { status: 200, etag: '"fake-etag"', stream: (async function* () { yield encoder.encode('remote-bytes'); })() };
    }),
    filesUploadOpen: vi.fn(async (path: string, size: number, o?: { mode?: string; sha256?: string }) => {
      calls.push(['open', path, size, o?.sha256]);
      if (options.openReply) return { ...options.openReply };
      session = { size, want: o?.sha256, data: new Uint8Array(size), spans: [] };
      return { upload_id: 'u-1', max_part_size: maxPartSize };
    }),
    filesUploadPart: vi.fn(
      async (uploadId: string, offset: number, content: Uint8Array, o?: { sha256?: string; signal?: AbortSignal }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          calls.push(['part', offset, content, o?.sha256]);
          if (options.onPart) await options.onPart({ signal: o?.signal });
          const failure = failParts.get(`${offset}:${content.byteLength}`);
          if (failure !== undefined) {
            failParts.delete(`${offset}:${content.byteLength}`);
            throw failure;
          }
          if (session === null) throw statusError(404, '{"error": "unknown upload session"}');
          if (o?.sha256 !== undefined && sha256(content) !== o.sha256) {
            throw statusError(400, '{"error": "sha256 mismatch on part"}');
          }
          if (offset + content.byteLength > session.size) {
            throw statusError(400, '{"error": "part writes past the end"}');
          }
          if (content.byteLength > maxPartSize) {
            throw statusError(413, '{"error": "part is larger than max_part_size"}');
          }
          session.data.set(content, offset);
          if (neverRecord.has(offset)) {
            // dropped: complete will report it missing forever
          } else if (forgetParts.has(offset)) {
            forgetParts.delete(offset); // forgotten once; a re-send records
          } else {
            record(offset, offset + content.byteLength);
          }
        } finally {
          inFlight -= 1;
        }
      },
    ),
    filesUploadStatus: vi.fn(async (uploadId: string) => {
      calls.push(['status', uploadId]);
      if (session === null) throw statusError(404, '{"error": "unknown upload session"}');
      return { size: session.size, ranges: session.spans.map(([start, end]) => ({ start, end })) };
    }),
    filesUploadComplete: vi.fn(async () => {
      calls.push(['complete']);
      if (session === null) throw statusError(404, '{"error": "unknown upload session"}');
      const miss = missing();
      if (miss.length > 0) {
        const body =
          options.raw409Body ??
          JSON.stringify({
            error: `${miss.length} range(s) still missing`,
            ranges: miss.map(([start, end]) => ({ start, end })),
          });
        throw statusError(409, body);
      }
      const digest = sha256(session.data);
      if (session.want !== undefined && digest !== session.want) {
        session = null;
        throw statusError(400, `{"error": "sha256 mismatch: got ${digest}"}`);
      }
      if (options.omitCompleteSha) return { size: session.size };
      return { size: session.size, sha256: options.lieAboutSha ?? digest };
    }),
    filesUploadAbort: vi.fn(async () => {
      calls.push(['abort']);
      if (options.abortError) throw statusError(404, '{"error": "unknown upload session"}');
      if (session === null) throw statusError(404, '{"error": "unknown upload session"}');
      session = null;
    }),
  };

  return {
    port,
    calls,
    kinds: () => calls.map((call) => call[0] as string),
    /** (offset, length) of every part PUT, in call order. */
    partPuts: () => calls.filter((call) => call[0] === 'part').map((call) => [call[1] as number, (call[2] as Uint8Array).byteLength] as [number, number]),
    landed: () => (session ? new Uint8Array(session.data) : null),
    maxInFlight: () => maxInFlight,
  };
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

/** The multipart session flow, Python parity: test_filesystem.py's multipart
 *  classes. The split cases run at MiB scale because the split floor is the
 *  real 1 MiB (Python patches its constant down; the sizes are still fast). */
const MIB = 1024 * 1024;
const DATA12 = new Uint8Array(12).map((_, i) => 97 + i); // 'abcdefghijkl'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'st136-'));
}

describe('upload defaults', () => {
  it('pins the documented defaults', () => {
    expect(UPLOAD_PART_SIZE).toBe(50 * 1024 * 1024);
    expect(UPLOAD_CONCURRENCY).toBe(4);
  });
});

describe('upload_file multipart dispatch', () => {
  it('a small file takes the single streamed PUT', async () => {
    const fake = uploadFake();
    const local = await tempFile('abc');

    try {
      await fsOf(fake.port).upload_file(local, '/r/small.bin');
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.kinds()).toEqual(['files_put']);
    expect(fake.landed()).toBeNull();
  });

  it('a size past part_size opens a session, parts at offsets, completes', async () => {
    const fake = uploadFake();
    const local = await tempFile(DATA12);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.kinds()[0]).toBe('open');
    expect(fake.kinds()).not.toContain('files_put');
    expect(fake.kinds()[fake.kinds().length - 1]).toBe('complete');
    expect(fake.landed()).toEqual(DATA12);
  });

  it('a zero-byte file takes the single streamed PUT', async () => {
    const fake = uploadFake();
    const local = await tempFile('');

    try {
      await fsOf(fake.port).upload_file(local, '/r/empty.bin', { part_size: 4 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.kinds()).toEqual(['files_put']);
  });

  it('caps part_size by the reply max_part_size', async () => {
    const fake = uploadFake({ maxPartSize: 3 });
    const local = await tempFile(DATA12);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.partPuts().sort((a, b) => a[0] - b[0])).toEqual([
      [0, 3],
      [3, 3],
      [6, 3],
      [9, 3],
    ]);
    expect(fake.landed()).toEqual(DATA12);
  });

  it('raises before any wire call on an invalid part_size', async () => {
    const fake = uploadFake();
    const local = await tempFile('abc');

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/x', { part_size: 0 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect(fake.calls).toEqual([]);
    } finally {
      await rm(local, { force: true });
    }
  });

  it('raises before any wire call on an invalid concurrency', async () => {
    const fake = uploadFake();
    const local = await tempFile('abc');

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/x', { concurrency: 0 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect(fake.calls).toEqual([]);
    } finally {
      await rm(local, { force: true });
    }
  });
});

describe('upload_file session wire', () => {
  it('open sends the path, the size and the whole-file digest', async () => {
    const fake = uploadFake();
    const local = await tempFile(DATA12);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    const openCall = fake.calls[0];
    expect(openCall[0]).toBe('open');
    expect(openCall[1]).toBe('/r/big.bin');
    expect(openCall[2]).toBe(12);
    expect(openCall[3]).toBe(sha256(DATA12));
  });

  it('parts carry their bytes at offsets with per-part digests', async () => {
    const fake = uploadFake();
    const local = await tempFile(DATA12);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.partPuts()).toEqual([
      [0, 4],
      [4, 4],
      [8, 4],
    ]);
    for (const call of fake.calls) {
      if (call[0] === 'part') {
        expect(call[3]).toBe(sha256(call[2] as Uint8Array));
      }
    }
    expect(fake.landed()).toEqual(DATA12);
  });

  it('raises corrupted in transit on a reply digest mismatch, and aborts', async () => {
    const fake = uploadFake({ lieAboutSha: 'ff'.repeat(32) });
    const local = await tempFile(DATA12);

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4 }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('corrupted in transit');
      expect(fake.kinds()).toContain('abort');
    } finally {
      await rm(local, { force: true });
    }
  });

  it("still succeeds when complete's reply carries no sha256 (contract-optional)", async () => {
    const fake = uploadFake({ omitCompleteSha: true });
    const local = await tempFile(DATA12);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.landed()).toEqual(DATA12);
    expect(fake.kinds()).not.toContain('abort');
  });

  it('aborts the live session when the open reply has no max_part_size', async () => {
    const fake = uploadFake({ openReply: { upload_id: 'u-1' } });
    const local = await tempFile(DATA12);

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('max_part_size');
      expect(fake.kinds().filter((kind) => kind === 'abort')).toHaveLength(1);
      expect(fake.kinds()).not.toContain('part');
    } finally {
      await rm(local, { force: true });
    }
  });

  it('raises without aborting on a malformed open reply', async () => {
    const fake = uploadFake({ openReply: { max_part_size: 4 } });
    const local = await tempFile(DATA12);

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4 }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('upload_id');
      expect(fake.kinds()).not.toContain('abort');
      expect(fake.kinds()).not.toContain('part');
    } finally {
      await rm(local, { force: true });
    }
  });
});

describe('upload_file concurrency', () => {
  const DATA32 = new Uint8Array(32).map((_, i) => i);

  it('holds four parts in flight at once (the barrier only passes when all four are truly simultaneous)', async () => {
    let arrived = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = uploadFake({
      onPart: () => {
        arrived += 1;
        if (arrived === 4) release();
        return released;
      },
    });
    const local = await tempFile(DATA32);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.maxInFlight()).toBe(4);
    expect(fake.landed()).toEqual(DATA32);
  });

  it('runs serially at concurrency one, in offset order', async () => {
    const fake = uploadFake();
    const local = await tempFile(DATA32);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.maxInFlight()).toBe(1);
    expect(fake.partPuts()).toEqual([
      [0, 4],
      [4, 4],
      [8, 4],
      [12, 4],
      [16, 4],
      [20, 4],
      [24, 4],
      [28, 4],
    ]);
  });
});

describe('upload_file timeout split', () => {
  // DATA12 scaled to the real 1 MiB split floor: parts at 8 MiB.
  const data12Mib = new Uint8Array(12 * MIB).map((_, i) => i & 0xff);
  const timeoutError = () => new SandboxTimeoutError('sbx', 60, 'Request timed out after 60s');

  it('splits a timed-out part into halves and retries', async () => {
    const fake = uploadFake({ failParts: { [`0:${8 * MIB}`]: timeoutError() } });
    const local = await tempFile(data12Mib);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 8 * MIB, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.partPuts().sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual([
      [0, 4 * MIB],
      [0, 8 * MIB],
      [4 * MIB, 4 * MIB],
      [8 * MIB, 4 * MIB],
    ]);
    expect(sha256(fake.landed()!)).toBe(sha256(data12Mib)); // hash compare: a 12 MiB deep-equal is slow
  });

  it('splits a Cloudflare 524 too (the ServiceError subclass trap: split-worthiness is checked before the 404 arm)', async () => {
    const fake = uploadFake({ failParts: { [`0:${8 * MIB}`]: new SandboxServiceError(524, 'origin timeout') } });
    const local = await tempFile(data12Mib);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 8 * MIB, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.partPuts().sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual([
      [0, 4 * MIB],
      [0, 8 * MIB],
      [4 * MIB, 4 * MIB],
      [8 * MIB, 4 * MIB],
    ]);
    expect(sha256(fake.landed()!)).toBe(sha256(data12Mib)); // hash compare: a 12 MiB deep-equal is slow
  });

  it('recurses: each half splits again until a part lands', async () => {
    const fake = uploadFake({
      failParts: {
        [`0:${8 * MIB}`]: timeoutError(),
        [`0:${4 * MIB}`]: timeoutError(),
      },
    });
    const local = await tempFile(data12Mib);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 8 * MIB, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.partPuts().sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual([
      [0, 2 * MIB],
      [0, 4 * MIB],
      [0, 8 * MIB],
      [2 * MIB, 2 * MIB],
      [4 * MIB, 4 * MIB],
      [8 * MIB, 4 * MIB],
    ]);
    expect(sha256(fake.landed()!)).toBe(sha256(data12Mib)); // hash compare: a 12 MiB deep-equal is slow
  });

  it('fails the upload when the failed part is below the split floor', async () => {
    const data2Mib = new Uint8Array(2 * MIB).map((_, i) => i & 0xff);
    const fake = uploadFake({ failParts: { [`0:${MIB}`]: timeoutError() } });
    const local = await tempFile(data2Mib);

    try {
      const error = await fsOf(fake.port)
        .upload_file(local, '/r/big.bin', { part_size: MIB, concurrency: 1 })
        .catch((e: unknown) => e);
      expect((error as Error).message).toContain('timed out');
      expect(fake.kinds()).toContain('abort');
    } finally {
      await rm(local, { force: true });
    }
  });
});

describe('upload_file abort on failure', () => {
  it('stops without draining the plan on a caller abort, and aborts the session', async () => {
    const controller = new AbortController();
    const fake = uploadFake({
      // Every part blocks until the caller aborts: the pool must stop with
      // only the in-flight parts, never drain the 20-part plan.
      onPart: (options) =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
        }),
    });
    const filesystem = fsOf(fake.port);
    const local = await tempFile(new Uint8Array(80));

    try {
      const pending = filesystem
        .upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 2, signal: controller.signal })
        .catch((e: unknown) => e);
      while (fake.partPuts().length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      controller.abort();
      const error = await pending;

      expect((error as Error).name).toBe('AbortError');
      expect(fake.partPuts().length).toBe(2); // did not drain the 20-part plan
      expect(fake.kinds()).toContain('abort');
      expect(fake.landed()).toBeNull();
    } finally {
      await rm(local, { force: true });
    }
  });

  it('aborts and raises on a hard part failure', async () => {
    const fake = uploadFake({
      failParts: { '4:4': statusError(400, '{"error": "sha256 mismatch on part"}') },
    });
    const local = await tempFile(DATA12);

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('Failed to upload file');
      expect(fake.kinds()).toContain('abort');
      expect(fake.landed()).toBeNull();
    } finally {
      await rm(local, { force: true });
    }
  });

  it("lets an abort failure never mask the original part failure", async () => {
    const fake = uploadFake({
      failParts: { '0:4': statusError(400, '{"error": "sha256 mismatch on part"}') },
      abortError: true,
    });
    const local = await tempFile(DATA12);

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('sha256 mismatch on part');
      expect(fake.kinds()).toContain('abort');
    } finally {
      await rm(local, { force: true });
    }
  });

  it('names the restart when the session was lost (a 404 on a part)', async () => {
    const fake = uploadFake({
      failParts: { '0:4': statusError(404, '{"error": "unknown upload session"}') },
    });
    const local = await tempFile(DATA12);

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('session was lost');
      expect(fake.kinds()).toContain('abort');
    } finally {
      await rm(local, { force: true });
    }
  });
});

describe('upload_file 409 resume', () => {
  it('fills the missing ranges from a 409 and completes again', async () => {
    const fake = uploadFake({ forgetParts: [4] });
    const local = await tempFile(DATA12);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.kinds().filter((kind) => kind === 'complete')).toHaveLength(2);
    expect(fake.partPuts()).toHaveLength(4); // 3 parts + the one fill, no full re-send
    expect(fake.partPuts()[3]).toEqual([4, 4]);
    expect(fake.landed()).toEqual(DATA12);
  });

  it('fills two missing ranges at once', async () => {
    const fake = uploadFake({ forgetParts: [4, 8] });
    const local = await tempFile(DATA12);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 });
    } finally {
      await rm(local, { force: true });
    }

    expect(fake.kinds().filter((kind) => kind === 'complete')).toHaveLength(2);
    expect(fake.partPuts()).toHaveLength(5);
    expect(fake.landed()).toEqual(DATA12);
  });

  it('raises instead of looping when a fill makes no progress', async () => {
    const fake = uploadFake({ neverRecord: [4] });
    const local = await tempFile(DATA12);

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('no progress');
      expect(fake.kinds().filter((kind) => kind === 'complete')).toHaveLength(2);
      expect(fake.kinds()).toContain('abort');
    } finally {
      await rm(local, { force: true });
    }
  });

  it('raises on an unparseable 409 body, not an Exists', async () => {
    const fake = uploadFake({ neverRecord: [4], raw409Body: 'not json' });
    const local = await tempFile(DATA12);

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('missing-ranges reply was unusable');
      expect(error).not.toBeInstanceOf(SandboxFileExistsError);
    } finally {
      await rm(local, { force: true });
    }
  });

  // A 409 is the resume signal only while its ranges parse as half-open
  // integer spans: anything malformed is an unusable reply — never a fill
  // loop, never an Exists. One test per malformed shape, Python parity for
  // the boundary the executor's body crosses.
  const unusable409 = async (raw409Body: string) => {
    const fake = uploadFake({ neverRecord: [4], raw409Body });
    const local = await tempFile(DATA12);

    try {
      const error = await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 4, concurrency: 1 }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('missing-ranges reply was unusable');
      expect(error).not.toBeInstanceOf(SandboxFileExistsError);
      expect(fake.kinds()).toContain('abort');
      expect(fake.kinds().filter((kind) => kind === 'complete')).toHaveLength(1); // no second complete on an unusable reply
    } finally {
      await rm(local, { force: true });
    }
  };

  it('treats a non-integer start as unusable', async () => {
    await unusable409('{"error": "incomplete", "ranges": [{"start": 1.5, "end": 4}]}');
  });

  it('treats a non-integer end as unusable', async () => {
    await unusable409('{"error": "incomplete", "ranges": [{"start": 4, "end": 8.5}]}');
  });

  it('treats an inverted range as unusable', async () => {
    await unusable409('{"error": "incomplete", "ranges": [{"start": 8, "end": 4}]}');
  });

  it('treats a negative start as unusable', async () => {
    await unusable409('{"error": "incomplete", "ranges": [{"start": -4, "end": 4}]}');
  });

  it('treats a missing ranges key as unusable', async () => {
    await unusable409('{"error": "incomplete"}');
  });

  it('treats an empty ranges array as unusable', async () => {
    await unusable409('{"error": "incomplete", "ranges": []}');
  });
});

describe('upload_file multipart progress', () => {
  it('never passes the file size across a 409 fill', async () => {
    const fake = uploadFake({ forgetParts: [4] });
    const local = await tempFile(DATA12);
    const seen: Array<[number, number]> = [];

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', {
        part_size: 4,
        concurrency: 1,
        progress: (done, total) => seen.push([done, total]),
      });
    } finally {
      await rm(local, { force: true });
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual([12, 12]);
    for (const [done, total] of seen) expect(done).toBeLessThanOrEqual(total);
  });

  it('reaches the full size, monotone', async () => {
    const fake = uploadFake();
    const local = await tempFile(DATA12);
    const seen: Array<[number, number]> = [];

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', {
        part_size: 4,
        concurrency: 1,
        progress: (done, total) => seen.push([done, total]),
      });
    } finally {
      await rm(local, { force: true });
    }

    expect(seen[seen.length - 1]).toEqual([12, 12]);
    const dones = seen.map(([done]) => done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
  });
});

describe('upload_file event loop', () => {
  it('stays responsive during the whole-file digest (async twin parity)', async () => {
    const fake = uploadFake();
    const data = new Uint8Array(24 * MIB).map((_, i) => i & 0xff);
    const local = await tempFile(data);
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 20);

    try {
      await fsOf(fake.port).upload_file(local, '/r/big.bin', { part_size: 8 * MIB });
    } finally {
      await rm(local, { force: true });
    }

    expect(ticked).toBe(true);
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

describe('download_file resume', () => {
  const CONTENT = encoder.encode('abcdefghijkl');
  const STAT = { type: 'file', size: CONTENT.length, mode: '0644', mtime: '2026-01-01T00:00:00Z' };

  /** The port with a scripted filesReadRange sequence and a fixed stat. */
  function resumePort(attempts: RangeAttempt[], stat: unknown = STAT) {
    const port = fakePort({ hasFilesRoutes: true, filesReadRange: attempts, filesStat: stat as never });
    return port;
  }

  async function withTarget(fn: (target: string) => Promise<void>): Promise<void> {
    const dir = await tempDir();
    try {
      await fn(join(dir, 'out.bin'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('resumes with Range + If-Range after a mid-stream network error, byte-identical', async () => {
    const port = resumePort([
      { etag: '"v1"', chunks: [encoder.encode('abc')], failWith: new TypeError('socket hang up') },
      { status: 206, etag: '"v1"', chunks: [encoder.encode('defghijkl')] },
    ]);

    await withTarget(async (target) => {
      await fsOf(port).download_file('/remote.bin', target);
      expect(new Uint8Array(await readFile(target))).toEqual(CONTENT);
      expect(existsSync(`${target}.part`)).toBe(false);
    });

    const rangeCalls = port.calls.filter((call) => call[0] === 'files_read_range');
    expect(rangeCalls).toHaveLength(2);
    expect(rangeCalls[0].slice(2)).toEqual([undefined, undefined]); // the first GET: no resume headers
    expect(rangeCalls[1].slice(2)).toEqual(['bytes=3-', '"v1"']);
  });

  it('restarts from scratch when If-Range misses: the file changed under us', async () => {
    const fresh = encoder.encode('XYZ-NEW-CONTENT');
    const port = fakePort({
      hasFilesRoutes: true,
      filesStat: { type: 'file', size: fresh.length, mode: '0644', mtime: '2026-01-02T00:00:00Z' },
      filesReadRange: [
        { etag: '"v1"', chunks: [encoder.encode('abc')], failWith: new TypeError('socket hang up') },
        { status: 200, etag: '"v2"', chunks: [fresh] },
      ],
    });

    await withTarget(async (target) => {
      await fsOf(port).download_file('/remote.bin', target);
      expect(new Uint8Array(await readFile(target))).toEqual(fresh); // the old bytes never survived
    });

    const rangeCalls = port.calls.filter((call) => call[0] === 'files_read_range');
    expect(rangeCalls[1].slice(2)).toEqual(['bytes=3-', '"v1"']); // it asked to resume
  });

  it('resumes a short read: the stream ended before the stat size', async () => {
    const port = resumePort([
      { etag: '"v1"', chunks: [encoder.encode('abc')] }, // ends cleanly at 3 < 12
      { status: 206, etag: '"v1"', chunks: [encoder.encode('defghijkl')] },
    ]);

    await withTarget(async (target) => {
      await fsOf(port).download_file('/remote.bin', target);
      expect(new Uint8Array(await readFile(target))).toEqual(CONTENT);
    });

    expect(port.calls.filter((call) => call[0] === 'files_read_range').length).toBe(2);
  });

  it('surfaces a 4xx mid-download without retrying: the executor answered', async () => {
    const port = resumePort([
      { etag: '"v1"', chunks: [encoder.encode('abc')], failWith: statusError(400, '{"error": "bad range"}') },
    ]);

    await withTarget(async (target) => {
      const error = await fsOf(port).download_file('/remote.bin', target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toContain('bad range');
      expect(existsSync(`${target}.part`)).toBe(false);
    });

    expect(port.calls.filter((call) => call[0] === 'files_read_range')).toHaveLength(1);
  });

  it('surfaces the last failure after the stalled budget is spent', async () => {
    // Only the timeout functions are faked — the download's fs IO (open,
    // close, rm) completes on real loop turns, which a fully faked clock
    // starves between advances.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const port = resumePort([
      { etag: '"v1"', failWith: new TypeError('socket hang up') },
      { status: 206, etag: '"v1"', failWith: new TypeError('socket hang up') },
      { status: 206, etag: '"v1"', failWith: new TypeError('socket hang up') },
      { status: 206, etag: '"v1"', failWith: new TypeError('socket hang up') },
    ]);
    const dir = await tempDir();
    const target = join(dir, 'out.bin');

    try {
      const pending = fsOf(port).download_file('/remote.bin', target).catch((e: unknown) => e);
      // Drive the fake clock until the budget is spent: each iteration also
      // yields a real macrotask turn so the chain's fs IO can complete.
      let error: unknown = 'unsettled';
      for (let i = 0; i < 32 && error === 'unsettled'; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise((resolve) => setImmediate(resolve));
        error = await Promise.race([pending, 'unsettled']);
      }

      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toContain('socket hang up');
      expect(port.calls.filter((call) => call[0] === 'files_read_range')).toHaveLength(4); // 1 + 3 retries
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restarts from scratch when a file without a validator fails mid-stream (pseudo-files)', async () => {
    const port = fakePort({
      hasFilesRoutes: true,
      filesStat: { type: 'other', size: 0, mode: '0644', mtime: '2026-01-01T00:00:00Z' },
      filesReadRange: [
        { chunks: [encoder.encode('abc')], failWith: new TypeError('socket hang up') }, // no etag
        { chunks: [encoder.encode('abcdef')] }, // the whole content again
      ],
    });

    await withTarget(async (target) => {
      await fsOf(port).download_file('/proc/cpuinfo', target);
      expect(new Uint8Array(await readFile(target))).toEqual(encoder.encode('abcdef')); // no doubled bytes
    });

    const rangeCalls = port.calls.filter((call) => call[0] === 'files_read_range');
    expect(rangeCalls[1].slice(2)).toEqual([undefined, undefined]); // restart: no Range without a validator
  });

  it('counts a validator-less discard against the stall budget: a stream that keeps dying mid-body surfaces', async () => {
    // Only the timeout functions are faked — the download's fs IO completes
    // on real loop turns, which a fully faked clock starves (see the
    // stalled-budget test above).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const dyingAttempt = () => ({ chunks: [encoder.encode('abc')], failWith: new TypeError('socket hang up') });
    const port = fakePort({
      hasFilesRoutes: true,
      filesStat: { type: 'other', size: 0, mode: '0644', mtime: '2026-01-01T00:00:00Z' },
      filesReadRange: [dyingAttempt(), dyingAttempt(), dyingAttempt(), dyingAttempt()],
    });
    const dir = await tempDir();
    const target = join(dir, 'out.bin');

    try {
      const pending = fsOf(port).download_file('/proc/cpuinfo', target).catch((e: unknown) => e);
      let error: unknown = 'unsettled';
      for (let i = 0; i < 32 && error === 'unsettled'; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise((resolve) => setImmediate(resolve));
        error = await Promise.race([pending, 'unsettled']);
      }

      // Each attempt lands bytes, but the validator-less restart discards
      // them: no net progress, so the budget must spend and surface — the
      // raw bytes never double, and the loop never spins forever.
      expect(error).toBeInstanceOf(SandboxFilesystemError);
      expect((error as Error).message).toContain('socket hang up');
      expect(port.calls.filter((call) => call[0] === 'files_read_range')).toHaveLength(4); // 1 + the 3 budget
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a caller abort raw and leaves no .part', async () => {
    const port = resumePort([
      { etag: '"v1"', chunks: [encoder.encode('abc')], failWith: new DOMException('aborted', 'AbortError') },
    ]);

    await withTarget(async (target) => {
      const error = await fsOf(port).download_file('/remote.bin', target).catch((e: unknown) => e);
      expect((error as Error).name).toBe('AbortError');
      expect(existsSync(`${target}.part`)).toBe(false);
    });

    expect(port.calls.filter((call) => call[0] === 'files_read_range')).toHaveLength(1); // aborts never retry
  });

  it('reports progress across the resume, monotone to the full size', async () => {
    const port = resumePort([
      { etag: '"v1"', chunks: [encoder.encode('abc')], failWith: new TypeError('socket hang up') },
      { status: 206, etag: '"v1"', chunks: [encoder.encode('defghijkl')] },
    ]);
    const seen: Array<[number, number]> = [];

    await withTarget(async (target) => {
      await fsOf(port).download_file('/remote.bin', target, {
        progress: (done, total) => seen.push([done, total]),
      });
      expect(new Uint8Array(await readFile(target))).toEqual(CONTENT);
    });

    expect(seen[seen.length - 1]).toEqual([12, 12]);
    const dones = seen.map(([done]) => done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
    for (const [done, total] of seen) expect(done).toBeLessThanOrEqual(total);
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
