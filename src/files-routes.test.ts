import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

import { ExecutorGateway } from './executor-gateway.js';
import {
  SandboxConnectionError,
  SandboxError,
  SandboxRequestError,
  SandboxServiceError,
  SandboxTimeoutError,
} from './errors.js';

/**
 * Pins the raw-bytes /files transport on the executor gateway.
 *
 * The streamed routes (executor v0.0.24+) are a raw-HTTP contract: query-
 * parameter routes, real status codes with {"error": ...} bodies, and raw
 * byte streams. These tests pin the gateway side of that contract against a
 * fake send seam, the way executor-gateway.test.ts pins the retry seam.
 * Python parity: koyeb/sandbox/test_files_routes.py.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A send seam that hangs until its request signal aborts, like undici. */
function hangingSend() {
  return vi.fn((_path: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  );
}

/** Consume whatever body the gateway handed to send (bytes, Blob or stream). */
async function readBody(init: RequestInit): Promise<Uint8Array> {
  return new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
}

function streamOfChunks(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('files_stat', () => {
  it('sends GET with the encoded path and returns the entry', async () => {
    const send = vi.fn(async (_path: string, _init: RequestInit) =>
      jsonResponse({ type: 'file', size: 5, mode: '0644', mtime: '2026-10-27T10:00:00Z' }),
    );
    const gateway = new ExecutorGateway(send);

    const entry = await gateway.filesStat('/tmp/a.txt');

    expect(send).toHaveBeenCalledTimes(1);
    const [path, init] = send.mock.calls[0];
    expect(path).toBe('/files/stat?path=%2Ftmp%2Fa.txt');
    expect(init.method).toBe('GET');
    expect(entry).toEqual({ type: 'file', size: 5, mode: '0644', mtime: '2026-10-27T10:00:00Z' });
  });

  it('maps 404 to SandboxRequestError', async () => {
    const send = vi.fn(async () => jsonResponse({ error: 'file does not exist' }, 404));
    const gateway = new ExecutorGateway(send);

    const error = await gateway.filesStat('/tmp/missing.txt').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect((error as SandboxRequestError).status_code).toBe(404);
  });

  it('names the 30s total cap, like every other JSON route', async () => {
    vi.useFakeTimers();
    const send = hangingSend();
    const gateway = new ExecutorGateway(send, { name: 'sbx' });

    const pending = gateway.filesStat('/tmp/a.txt');
    const errorPromise = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(SandboxTimeoutError);
    expect((error as Error).message).toBe('Request timed out after 30s');
  });
});

describe('files_put', () => {
  it('streams the body and returns the commit reply', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (path: string, init: RequestInit) => {
      seen['path'] = path;
      seen['method'] = init.method;
      seen['contentType'] = new Headers(init.headers).get('Content-Type');
      seen['sha'] = new Headers(init.headers).get('X-Content-SHA256');
      seen['body'] = await readBody(init);
      return jsonResponse({ size: 3, sha256: 'deadbeef' });
    });
    const gateway = new ExecutorGateway(send);

    const reply = await gateway.filesPut('/tmp/a.txt', new TextEncoder().encode('xyz'), {
      mode: '0600',
      parents: true,
      sha256: 'deadbeef',
    });

    expect(seen['method']).toBe('PUT');
    expect(seen['path']).toBe('/files?path=%2Ftmp%2Fa.txt&mode=0600&parents=1');
    expect(seen['contentType']).toBe('application/octet-stream');
    expect(seen['sha']).toBe('deadbeef');
    expect(new TextDecoder().decode(seen['body'] as Uint8Array)).toBe('xyz');
    expect(reply).toEqual({ size: 3, sha256: 'deadbeef' });
  });

  it('accepts stream content', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (_path: string, init: RequestInit) => {
      seen['body'] = await readBody(init);
      return jsonResponse({ size: 6, sha256: 'sum' });
    });
    const gateway = new ExecutorGateway(send);

    await gateway.filesPut('/tmp/a.txt', streamOfChunks([new TextEncoder().encode('ab'), new TextEncoder().encode('cdef')]));

    expect(new TextDecoder().decode(seen['body'] as Uint8Array)).toBe('abcdef');
  });

  it('converts a Node stream body to the web stream fetch requires', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (_path: string, init: RequestInit) => {
      seen['duplex'] = (init as { duplex?: string }).duplex;
      seen['body'] = await readBody(init);
      return jsonResponse({ size: 6, sha256: 's' });
    });
    const gateway = new ExecutorGateway(send);

    await gateway.filesPut('/tmp/a.txt', Readable.from([new TextEncoder().encode('ab'), new TextEncoder().encode('cdef')]));

    expect(seen['duplex']).toBe('half');
    expect(new TextDecoder().decode(seen['body'] as Uint8Array)).toBe('abcdef');
  });

  it('is not retried on a mid-stream failure: a streamed body cannot be replayed', async () => {
    const send = vi.fn(async () => {
      throw new TypeError('fetch failed: socket reset mid-stream');
    });
    const gateway = new ExecutorGateway(send);

    await expect(gateway.filesPut('/tmp/a.txt', new TextEncoder().encode('xyz'))).rejects.toThrow(TypeError);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('omits the parents flag unless asked', async () => {
    const send = vi.fn(async (_path: string, _init: RequestInit) => jsonResponse({ size: 0, sha256: 's' }));
    const gateway = new ExecutorGateway(send);

    await gateway.filesPut('/tmp/a.txt', new TextEncoder().encode('abc'));

    expect(send.mock.calls[0][0]).toBe('/files?path=%2Ftmp%2Fa.txt');
  });

  it('refuses a 200 reply that carries no sha256', async () => {
    const send = vi.fn(async () => jsonResponse({ size: 3 }));
    const gateway = new ExecutorGateway(send);

    await expect(gateway.filesPut('/tmp/a.txt', new TextEncoder().encode('xyz'))).rejects.toThrow(
      'malformed /files reply',
    );
  });

  it('maps a 400 mismatch to SandboxRequestError', async () => {
    const send = vi.fn(async () => jsonResponse({ error: 'sha256 mismatch: got a, expected b' }, 400));
    const gateway = new ExecutorGateway(send);

    const error = await gateway.filesPut('/a', new TextEncoder().encode('x')).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect((error as SandboxRequestError).status_code).toBe(400);
  });
});

describe('files_read', () => {
  async function collect(stream: AsyncGenerator<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  }

  it('yields chunks from the GET stream', async () => {
    const send = vi.fn(async (path: string, init: RequestInit) => {
      expect(path).toBe('/files?path=%2Ftmp%2Fa.txt');
      expect(init.method).toBe('GET');
      return new Response(streamOfChunks([new TextEncoder().encode('ab'), new TextEncoder().encode('cdef')]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    });
    const gateway = new ExecutorGateway(send);

    const chunks = await collect(await gateway.filesRead('/tmp/a.txt'));

    expect(chunks.map((c) => new TextDecoder().decode(c)).join('')).toBe('abcdef');
  });

  it('maps 404 to SandboxRequestError', async () => {
    const send = vi.fn(async () => jsonResponse({ error: 'file does not exist' }, 404));
    const gateway = new ExecutorGateway(send);

    const error = await gateway.filesRead('/tmp/missing.txt').next().catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect((error as SandboxRequestError).status_code).toBe(404);
  });

  it('maps 500 to SandboxServiceError', async () => {
    const send = vi.fn(async () => new Response('boom', { status: 500 }));
    const gateway = new ExecutorGateway(send);

    const error = await gateway.filesRead('/a').next().catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxServiceError);
  });

  it('maps 400 to SandboxRequestError (the boundary between the two arms)', async () => {
    const send = vi.fn(async () => jsonResponse({ error: 'is a directory' }, 400));
    const gateway = new ExecutorGateway(send);

    const error = await gateway.filesRead('/a').next().catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect((error as SandboxRequestError).status_code).toBe(400);
  });
});

describe('files_upload_open', () => {
  it('sends POST with the session payload and returns the reply', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (_path: string, init: RequestInit, body?: unknown) => {
      seen['method'] = init.method;
      seen['body'] = body;
      return jsonResponse({ upload_id: 'u-1', max_part_size: 104857600 });
    });
    const gateway = new ExecutorGateway(send);

    const reply = await gateway.filesUploadOpen('/tmp/a.bin', 1024, {
      mode: '0644',
      sha256: 'ab'.repeat(32),
    });

    expect(send.mock.calls[0][0]).toBe('/files/uploads');
    expect(seen['method']).toBe('POST');
    expect(seen['body']).toEqual({
      path: '/tmp/a.bin',
      size: 1024,
      mode: '0644',
      sha256: 'ab'.repeat(32),
    });
    expect(reply).toEqual({ upload_id: 'u-1', max_part_size: 104857600 });
  });

  it('omits the optionals when not asked', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (_path: string, _init: RequestInit, body?: unknown) => {
      seen['body'] = body;
      return jsonResponse({ upload_id: 'u-2', max_part_size: 1 });
    });
    const gateway = new ExecutorGateway(send);

    await gateway.filesUploadOpen('/tmp/a.bin', 0);

    expect(seen['body']).toEqual({ path: '/tmp/a.bin', size: 0 });
  });

  it('does not retry a 500: a blind retry orphans a session', async () => {
    const send = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const gateway = new ExecutorGateway(send);

    await expect(gateway.filesUploadOpen('/tmp/a.bin', 1024)).rejects.toBeInstanceOf(SandboxServiceError);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not retry a network error: fetch cannot prove the open never reached the executor', async () => {
    const send = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const gateway = new ExecutorGateway(send);

    await expect(gateway.filesUploadOpen('/tmp/a.bin', 1024)).rejects.toBeInstanceOf(SandboxConnectionError);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('maps a 400 to SandboxRequestError', async () => {
    const send = vi.fn(async () =>
      jsonResponse({ error: 'size is required and must be a non-negative integer' }, 400),
    );
    const gateway = new ExecutorGateway(send);

    const error = await gateway.filesUploadOpen('/tmp/a.bin', -1).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect((error as SandboxRequestError).status_code).toBe(400);
  });
});

describe('files_upload_part', () => {
  it('writes the part at its offset with the digest header', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (path: string, init: RequestInit) => {
      seen['path'] = path;
      seen['method'] = init.method;
      seen['contentType'] = new Headers(init.headers).get('Content-Type');
      seen['sha'] = new Headers(init.headers).get('X-Content-SHA256');
      seen['body'] = await readBody(init);
      return new Response(null, { status: 204 });
    });
    const gateway = new ExecutorGateway(send);

    await gateway.filesUploadPart('u-1', 50, new TextEncoder().encode('abc'), { sha256: 'ff'.repeat(32) });

    expect(seen['path']).toBe('/files/uploads/u-1?offset=50');
    expect(seen['method']).toBe('PUT');
    expect(seen['contentType']).toBe('application/octet-stream');
    expect(seen['sha']).toBe('ff'.repeat(32));
    expect(new TextDecoder().decode(seen['body'] as Uint8Array)).toBe('abc');
  });

  it('retries a transient network error: the part is replayable bytes', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed: socket reset');
      return new Response(null, { status: 204 });
    });
    const gateway = new ExecutorGateway(send);

    const pending = gateway.filesUploadPart('u-1', 0, new TextEncoder().encode('abc'));
    await vi.advanceTimersByTimeAsync(1_000); // the retry backoff
    await pending;

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx like the JSON routes: the executor overwrites the same bytes', async () => {
    vi.useFakeTimers();
    const statuses = [503, 503, 204];
    const send = vi.fn(async () => {
      const status = statuses.shift()!;
      return status === 204 ? new Response(null, { status }) : jsonResponse({ error: 'unavailable' }, status);
    });
    const gateway = new ExecutorGateway(send);

    const pending = gateway.filesUploadPart('u-1', 0, new TextEncoder().encode('abc'));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(send).toHaveBeenCalledTimes(3);
  });

  it('surfaces a 4xx without retrying: the executor answered', async () => {
    const send = vi.fn(async () => jsonResponse({ error: 'unknown upload session' }, 404));
    const gateway = new ExecutorGateway(send);

    const error = await gateway.filesUploadPart('gone', 0, new TextEncoder().encode('abc')).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect((error as SandboxRequestError).status_code).toBe(404);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds idle time like a streamed body: names the 60s bound, never retried', async () => {
    vi.useFakeTimers();
    const send = hangingSend();
    const gateway = new ExecutorGateway(send, { name: 'sbx' });

    const pending = gateway.filesUploadPart('u-1', 0, new TextEncoder().encode('abc'));
    const errorPromise = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(SandboxTimeoutError);
    expect((error as Error).message).toBe('Request timed out after 60s');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("honors the caller's signal mid-flight: the raw abort surfaces", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const send = hangingSend();
    const gateway = new ExecutorGateway(send, { name: 'sbx' });

    const pending = gateway.filesUploadPart('u-1', 0, new TextEncoder().encode('abc'), {
      signal: controller.signal,
    });
    const errorPromise = pending.catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await errorPromise;

    expect((error as Error).name).toBe('AbortError');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('files_upload_status', () => {
  it('returns the size and the received ranges', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (path: string, init: RequestInit) => {
      seen['path'] = path;
      seen['method'] = init.method;
      return jsonResponse({ size: 12, ranges: [{ start: 0, end: 4 }, { start: 8, end: 12 }] });
    });
    const gateway = new ExecutorGateway(send);

    const status = await gateway.filesUploadStatus('u-1');

    expect(seen['path']).toBe('/files/uploads/u-1');
    expect(seen['method']).toBe('GET');
    expect(status).toEqual({ size: 12, ranges: [{ start: 0, end: 4 }, { start: 8, end: 12 }] });
  });
});

describe('files_upload_complete', () => {
  it('returns the commit reply', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (path: string, init: RequestInit) => {
      seen['path'] = path;
      seen['method'] = init.method;
      return jsonResponse({ size: 12, sha256: 'ff'.repeat(32) });
    });
    const gateway = new ExecutorGateway(send);

    const reply = await gateway.filesUploadComplete('u-1');

    expect(seen['path']).toBe('/files/uploads/u-1/complete');
    expect(seen['method']).toBe('POST');
    expect(reply).toEqual({ size: 12, sha256: 'ff'.repeat(32) });
  });

  it('does not retry a 500: a blind retry double-submits', async () => {
    const send = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const gateway = new ExecutorGateway(send);

    await expect(gateway.filesUploadComplete('u-1')).rejects.toBeInstanceOf(SandboxServiceError);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('carries the 409 ranges in the error body: the resume signal', async () => {
    const send = vi.fn(async () =>
      jsonResponse(
        { error: '1 range(s) of the upload are still missing', ranges: [{ start: 4, end: 8 }] },
        409,
      ),
    );
    const gateway = new ExecutorGateway(send);

    const error = await gateway.filesUploadComplete('u-1').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect((error as SandboxRequestError).status_code).toBe(409);
    expect((error as SandboxRequestError).body).toEqual({
      error: '1 range(s) of the upload are still missing',
      ranges: [{ start: 4, end: 8 }],
    });
  });
});

describe('files_upload_abort', () => {
  it('deletes the session', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (path: string, init: RequestInit) => {
      seen['path'] = path;
      seen['method'] = init.method;
      return new Response(null, { status: 204 });
    });
    const gateway = new ExecutorGateway(send);

    await gateway.filesUploadAbort('u-1');

    expect(seen['path']).toBe('/files/uploads/u-1');
    expect(seen['method']).toBe('DELETE');
  });
});

describe('files_read_range', () => {
  it('returns the status, the etag and the streamed body', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (path: string, init: RequestInit) => {
      seen['path'] = path;
      seen['method'] = init.method;
      seen['range'] = new Headers(init.headers).get('Range');
      return new Response(streamOfChunks([new TextEncoder().encode('ab'), new TextEncoder().encode('cdef')]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', ETag: '"c-1b"' },
      });
    });
    const gateway = new ExecutorGateway(send);

    const reply = await gateway.filesReadRange('/tmp/a.txt');

    expect(seen['path']).toBe('/files?path=%2Ftmp%2Fa.txt');
    expect(seen['method']).toBe('GET');
    expect(seen['range']).toBeNull();
    expect(reply.status).toBe(200);
    expect(reply.etag).toBe('"c-1b"');
    const chunks: Uint8Array[] = [];
    for await (const chunk of reply.stream) chunks.push(chunk);
    expect(chunks.map((c) => new TextDecoder().decode(c)).join('')).toBe('abcdef');
  });

  it('sends Range and If-Range for a resume', async () => {
    const seen: Record<string, unknown> = {};
    const send = vi.fn(async (_path: string, init: RequestInit) => {
      seen['range'] = new Headers(init.headers).get('Range');
      seen['ifRange'] = new Headers(init.headers).get('If-Range');
      return new Response(streamOfChunks([new TextEncoder().encode('cdef')]), {
        status: 206,
        headers: { 'Content-Type': 'application/octet-stream', ETag: '"c-1b"' },
      });
    });
    const gateway = new ExecutorGateway(send);

    const reply = await gateway.filesReadRange('/tmp/a.txt', { range: 'bytes=2-', ifRange: '"c-1b"' });

    expect(seen['range']).toBe('bytes=2-');
    expect(seen['ifRange']).toBe('"c-1b"');
    expect(reply.status).toBe(206);
    expect(reply.etag).toBe('"c-1b"');
  });

  it('maps 404 to SandboxRequestError', async () => {
    const send = vi.fn(async () => jsonResponse({ error: 'file does not exist' }, 404));
    const gateway = new ExecutorGateway(send);

    const error = await gateway.filesReadRange('/tmp/missing.txt').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(SandboxRequestError);
    expect((error as SandboxRequestError).status_code).toBe(404);
  });
});

describe('has_files_routes', () => {
  it('404 means legacy: cached, warned once', async () => {
    const calls: string[] = [];
    const send = vi.fn(async (path: string) => {
      calls.push(path);
      return new Response('404 page not found', { status: 404 });
    });
    const gateway = new ExecutorGateway(send);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await gateway.hasFilesRoutes()).toBe(false);
    expect(await gateway.hasFilesRoutes()).toBe(false);

    expect(calls).toEqual(['/files/stat']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('legacy');
  });

  it('400 means the new routes: cached, no warning', async () => {
    const send = vi.fn(async () => jsonResponse({ error: 'path is required' }, 400));
    const gateway = new ExecutorGateway(send);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await gateway.hasFilesRoutes()).toBe(true);
    expect(await gateway.hasFilesRoutes()).toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('2xx means the routes are available', async () => {
    const send = vi.fn(async () => jsonResponse({ type: 'file' }));
    const gateway = new ExecutorGateway(send);

    expect(await gateway.hasFilesRoutes()).toBe(true);
  });

  it('429 raises without caching: a rate-limit blip says nothing about the routes', async () => {
    const send = vi.fn(async () => new Response('slow down', { status: 429 }));
    const gateway = new ExecutorGateway(send);

    for (let i = 0; i < 2; i++) {
      const error = await gateway.hasFilesRoutes().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SandboxError);
      expect((error as Error).message).toBe('Failed probing /files routes: HTTP 429');
    }

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight probe between concurrent first calls', async () => {
    const send = vi.fn(async () => new Response('404 page not found', { status: 404 }));
    const gateway = new ExecutorGateway(send);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const [first, second] = await Promise.all([gateway.hasFilesRoutes(), gateway.hasFilesRoutes()]);

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('releases the caller signal listener when the transfer finishes', async () => {
    const send = vi.fn(async (_path: string, init: RequestInit) => {
      await readBody(init);
      return jsonResponse({ size: 3, sha256: 's' });
    });
    const gateway = new ExecutorGateway(send);
    const controller = new AbortController();

    await gateway.filesPut('/tmp/a.txt', new TextEncoder().encode('xyz'), { signal: controller.signal });

    // A long-lived caller signal reused across transfers must not accumulate listeners.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it("honors the caller's signal after the transfer started moving", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const send = vi.fn(async (_path: string, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      await reader.read(); // first chunk flows: the transfer has activity now
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const gateway = new ExecutorGateway(send);

    const pending = gateway.filesPut('/tmp/a.txt', new Uint8Array(64 * 1024), { signal: controller.signal });
    const rejection = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0); // let the first chunk flow
    controller.abort(); // mid-flight, after activity
    await vi.advanceTimersByTimeAsync(60_000); // if the abort were dropped, the idle bound would misfire
    const error = await rejection;

    expect((error as Error).name).toBe('AbortError');
  });

  it('401 raises without caching', async () => {
    const send = vi.fn(async () => new Response('no', { status: 401 }));
    const gateway = new ExecutorGateway(send);

    await expect(gateway.hasFilesRoutes()).rejects.toThrow('Failed probing /files routes: HTTP 401');
    await expect(gateway.hasFilesRoutes()).rejects.toThrow('Failed probing /files routes: HTTP 401');

    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('files route timeouts', () => {
  it('does not run the idle clock while the consumer holds a chunk', async () => {
    vi.useFakeTimers();
    // undici tears the response body down when the request signal aborts; the
    // fake models that, so a timeout during a consumer's pause is observable.
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const send = vi.fn(async (_path: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          controller.enqueue(new TextEncoder().encode('ab'));
        },
      });
      init.signal?.addEventListener('abort', () =>
        body.error(new DOMException('This operation was aborted', 'AbortError')),
      );
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    });
    const gateway = new ExecutorGateway(send);
    const chunks = gateway.filesRead('/tmp/a.txt');

    const first = await chunks.next();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value!)).toBe('ab');
    await vi.advanceTimersByTimeAsync(120_000); // the consumer sleeps far past 60 s
    body.enqueue(new TextEncoder().encode('cd')); // the server keeps producing
    const second = await chunks.next();
    expect(second.done).toBe(false);
    expect(new TextDecoder().decode(second.value!)).toBe('cd');

    await chunks.return(undefined);
  });

  it('bounds idle time on the streamed PUT: names the 60s bound', async () => {
    vi.useFakeTimers();
    const send = hangingSend();
    const gateway = new ExecutorGateway(send, { name: 'sbx' });

    const pending = gateway.filesPut('/tmp/a.txt', new TextEncoder().encode('xyz'));
    const errorPromise = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(SandboxTimeoutError);
    expect((error as SandboxTimeoutError).timeout).toBe(60);
    expect((error as Error).message).toBe('Request timed out after 60s');
  });

  it('re-arms the idle window as a buffered body flows: slow but moving completes', async () => {
    vi.useFakeTimers();
    // Four 64 KiB chunks pulled thirty seconds apart: 120 s total, past the
    // 60 s idle bound — only the per-chunk re-arm keeps a moving transfer alive.
    const buffer = new Uint8Array(4 * 64 * 1024).fill(7);
    const send = vi.fn(async (_path: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(ReadableStream);
      expect((init as { duplex?: string }).duplex).toBe('half');
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(bytes).toBe(buffer.byteLength);
      return jsonResponse({ size: bytes, sha256: 's' });
    });
    const gateway = new ExecutorGateway(send);

    const reply = await gateway.filesPut('/tmp/big.bin', buffer);

    expect(reply.size).toBe(buffer.byteLength);
  });

  it('bounds idle time on the streamed GET: a stalled body names the 60s bound', async () => {
    vi.useFakeTimers();
    // Headers arrive, one chunk flows, then the body stalls forever.
    const send = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first'));
          // never closes, never enqueues again
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    });
    const gateway = new ExecutorGateway(send, { name: 'sbx' });

    const stream = await gateway.filesRead('/tmp/a.txt');
    const first = await stream.next();
    expect(new TextDecoder().decode(first.value!)).toBe('first');

    const errorPromise = stream.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await errorPromise;

    expect(error).toBeInstanceOf(SandboxTimeoutError);
    expect((error as Error).message).toBe('Request timed out after 60s');
  });

  it('a reset mid-stream is the raw failure, not a timeout', async () => {
    const send = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'));
        },
        pull() {
          return Promise.reject(new TypeError('socket hang up'));
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    });
    const gateway = new ExecutorGateway(send);

    const stream = await gateway.filesRead('/a');
    await stream.next();
    const error = await stream.next().catch((error: unknown) => error);

    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(SandboxTimeoutError);
  });

  it('honors a caller abort mid-flight: the raw abort surfaces, not a timeout', async () => {
    vi.useFakeTimers();
    const send = hangingSend();
    const gateway = new ExecutorGateway(send, { name: 'sbx' });
    const controller = new AbortController();

    const pending = gateway.filesPut('/tmp/a.txt', new TextEncoder().encode('xyz'), { signal: controller.signal });
    const errorPromise = pending.catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await errorPromise;

    expect(error).not.toBeInstanceOf(SandboxTimeoutError);
    expect((error as Error).name).toBe('AbortError');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
