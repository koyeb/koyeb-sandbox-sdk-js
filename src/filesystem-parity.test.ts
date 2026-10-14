import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SandboxFilesystemError } from './errors.js';
import { makeSandbox } from './test-support.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type RequestImplementation = (path: string, init: RequestInit, body?: any) => Promise<unknown>;

function mockRequest(implementation?: RequestImplementation) {
  const sandbox = makeSandbox();
  const request = vi.fn(implementation);
  vi.spyOn(sandbox as never, 'request').mockImplementation(request as never);
  return { sandbox, fs: sandbox.filesystem, request };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sandbox-sdk-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The bytes of the PNG magic header followed by non-UTF-8 payloads — binary, never valid text. */
const BINARY_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);

/** base64 of BINARY_BYTES, i.e. the wire form the Python SDK sends via base64.b64encode(content).decode("ascii"). */
const BINARY_B64 = 'iVBORw0KGgoA//6A';

/** The executor as deployed today: content strings are stored and returned verbatim — the Python storage model. */
function currentExecutor() {
  const files = new Map<string, string>();
  const writes: Array<Record<string, unknown>> = [];
  const request = vi.fn(async (path: string, _init: unknown, body: any) => {
    if (path === '/write_file') {
      writes.push(body);
      files.set(body.path, body.content);
      return { success: true };
    }
    if (path === '/read_file') {
      if (!files.has(body.path)) {
        return { error: `open ${body.path}: no such file or directory` };
      }
      return { content: files.get(body.path) };
    }
    return { error: `unsupported endpoint ${path}` };
  });
  return { request, writes };
}

/** The Go CLI's documented binary wire contract: flagged writes store raw bytes; binary reads come back flagged base64. */
function flaggingExecutor() {
  const files = new Map<string, Uint8Array>();
  const request = vi.fn(async (path: string, _init: unknown, body: any) => {
    if (path === '/write_file') {
      files.set(body.path, body.is_base64 ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8'));
      return { success: true };
    }
    if (path === '/read_file') {
      const bytes = files.get(body.path);
      if (!bytes) {
        return { error: `open ${body.path}: no such file or directory` };
      }
      try {
        return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
      } catch {
        return { content: Buffer.from(bytes).toString('base64'), is_base64: true };
      }
    }
    return { error: `unsupported endpoint ${path}` };
  });
  return { request, files };
}

describe('binary file parity with the Python SDK', () => {
  it('write_file decodes bytes to text in the given encoding, like Python bytes.decode', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({});

    await fs.write_file('/tmp/a.txt', new TextEncoder().encode('héllo'));

    expect(request).toHaveBeenCalledWith(
      '/write_file',
      { method: 'POST' },
      {
        path: '/tmp/a.txt',
        content: 'héllo',
      },
    );
  });

  it('write_file leaves string content untouched, like the Python SDK', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({});

    await fs.write_file('/tmp/a.txt', 'plain text', 'base64');

    expect(request).toHaveBeenCalledWith(
      '/write_file',
      { method: 'POST' },
      {
        path: '/tmp/a.txt',
        content: 'plain text',
      },
    );
  });

  it('write_file wraps undecodable bytes in SandboxFilesystemError, like Python wraps UnicodeDecodeError', async () => {
    const { fs } = mockRequest();

    await expect(fs.write_file('/tmp/a.txt', BINARY_BYTES)).rejects.toBeInstanceOf(SandboxFilesystemError);
  });

  it('write_file base64-encodes bytes onto the wire, flagged with is_base64', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({});

    await fs.write_file('/tmp/img.png', BINARY_BYTES, 'base64');

    expect(request).toHaveBeenCalledWith(
      '/write_file',
      { method: 'POST' },
      {
        path: '/tmp/img.png',
        content: BINARY_B64,
        is_base64: true,
      },
    );
  });

  it('write_files carries per-entry encoding, like the Python SDK', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({});

    await fs.write_files([
      { path: '/tmp/a.txt', content: 'plain text' },
      { path: '/tmp/b.bin', content: BINARY_BYTES, encoding: 'base64' },
    ]);

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/write_file',
      { method: 'POST' },
      {
        path: '/tmp/a.txt',
        content: 'plain text',
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/write_file',
      { method: 'POST' },
      {
        path: '/tmp/b.bin',
        content: BINARY_B64,
        is_base64: true,
      },
    );
  });
});

describe('binary reads', () => {
  it('read_file decodes base64 content to bytes when encoding="base64", like the Python SDK', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({ content: BINARY_B64 });

    const info = await fs.read_file('/tmp/img.png', 'base64');

    expect(request).toHaveBeenCalledWith('/read_file', { method: 'POST' }, { path: '/tmp/img.png' });
    expect(Array.from(info.content as Uint8Array)).toEqual(Array.from(BINARY_BYTES));
    expect(info.encoding).toBe('base64');
  });

  it('read_file returns an empty byte array for omitted content, like Python b""', async () => {
    const { fs, request } = mockRequest();
    // Go omitempty drops an empty file's content field entirely.
    request.mockResolvedValue({});

    const info = await fs.read_file('/tmp/empty.bin', 'base64');

    expect(Array.from(info.content as Uint8Array)).toEqual([]);
    expect(info.encoding).toBe('base64');
  });

  it('read_file returns bytes when the executor flags the content as base64', async () => {
    // The Go wire contract's FileResponse marks binary content with is_base64.
    const { fs, request } = mockRequest();
    request.mockResolvedValue({ content: BINARY_B64, is_base64: true });

    const info = await fs.read_file('/tmp/img.png');

    expect(Array.from(info.content as Uint8Array)).toEqual(Array.from(BINARY_BYTES));
    expect(info.encoding).toBe('base64');
  });

  it('read_file keeps text responses as strings with the requested encoding', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({ content: 'hello', encoding: 'utf-8' });

    await expect(fs.read_file('/tmp/a.txt')).resolves.toEqual({
      content: 'hello',
      encoding: 'utf-8',
    });
  });
});

describe('binary transfers', () => {
  it('upload_file carries local bytes with the requested encoding, not a lossy string', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({});

    await withTempDir(async (dir) => {
      const local = join(dir, 'img.png');
      await writeFile(local, BINARY_BYTES);

      await fs.upload_file(local, '/tmp/img.png', 'base64');

      expect(request).toHaveBeenCalledWith(
        '/write_file',
        { method: 'POST' },
        {
          path: '/tmp/img.png',
          content: BINARY_B64,
          is_base64: true,
        },
      );
    });
  });

  it('upload_file keeps text uploads unchanged with the default utf-8 encoding', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({});

    await withTempDir(async (dir) => {
      const local = join(dir, 'a.txt');
      await writeFile(local, 'plain text');

      await fs.upload_file(local, '/tmp/a.txt');

      expect(request).toHaveBeenCalledWith(
        '/write_file',
        { method: 'POST' },
        {
          path: '/tmp/a.txt',
          content: 'plain text',
        },
      );
    });
  });

  it('download_file writes binary content to disk byte-identically', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({ content: BINARY_B64, is_base64: true });

    await withTempDir(async (dir) => {
      const local = join(dir, 'out.png');

      await fs.download_file('/tmp/img.png', local);

      expect(Array.from(await readFile(local))).toEqual(Array.from(BINARY_BYTES));
    });
  });

  it('download_file writes string content in the requested encoding, like Python str.encode', async () => {
    const { fs, request } = mockRequest();
    request.mockResolvedValue({ content: 'héllo' });

    await withTempDir(async (dir) => {
      const local = join(dir, 'out.txt');

      await fs.download_file('/tmp/a.txt', local, 'latin1');

      expect(Array.from(await readFile(local))).toEqual([0x68, 0xe9, 0x6c, 0x6c, 0x6f]);
    });
  });
});

describe('binary round-trip against the executor', () => {
  it('round-trips non-UTF-8 bytes unchanged against the deployed executor, like the Python SDK', async () => {
    const executor = currentExecutor();
    const { fs } = mockRequest(executor.request);

    await withTempDir(async (dir) => {
      const localIn = join(dir, 'in.png');
      const localOut = join(dir, 'out.png');
      await writeFile(localIn, BINARY_BYTES);

      await fs.upload_file(localIn, '/tmp/img.png', 'base64');
      await fs.download_file('/tmp/img.png', localOut, 'base64');

      expect(Array.from(await readFile(localOut))).toEqual(Array.from(BINARY_BYTES));
    });
  });

  it('pins the Python wire form: bytes travel as the same base64 the Python SDK sends', async () => {
    const executor = currentExecutor();
    const { fs } = mockRequest(executor.request);

    await fs.write_file('/tmp/img.png', BINARY_BYTES, 'base64');

    expect(executor.writes).toEqual([{ path: '/tmp/img.png', content: BINARY_B64, is_base64: true }]);
  });

  it('round-trips non-UTF-8 bytes unchanged against the is_base64 wire contract', async () => {
    const executor = flaggingExecutor();
    const { fs } = mockRequest(executor.request);

    await withTempDir(async (dir) => {
      const localIn = join(dir, 'in.png');
      const localOut = join(dir, 'out.png');
      await writeFile(localIn, BINARY_BYTES);

      await fs.upload_file(localIn, '/tmp/img.png', 'base64');
      await fs.download_file('/tmp/img.png', localOut);

      expect(Array.from(await readFile(localOut))).toEqual(Array.from(BINARY_BYTES));
    });
  });

  it('write_file → read_file returns the same bytes faithfully in FileInfo', async () => {
    const executor = flaggingExecutor();
    const { fs } = mockRequest(executor.request);

    await fs.write_file('/tmp/img.png', BINARY_BYTES, 'base64');
    const info = await fs.read_file('/tmp/img.png', 'base64');

    expect(info.encoding).toBe('base64');
    expect(Array.from(info.content as Uint8Array)).toEqual(Array.from(BINARY_BYTES));
  });
});
