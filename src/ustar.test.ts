import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

import {
  BLOCK_SIZE,
  UstarReader,
  ustarHeaders,
  ustarTrailer,
  type UstarMember,
} from './ustar.js';

/**
 * Pins the minimal ustar writer + reader behind sync()'s tar batches.
 *
 * The writer produces what the executor's Go extractor reads (ustar with a
 * prefix split for long names, GNU L/K beyond that, whole-second mtimes);
 * the reader consumes what the executor's Go writer produces (ustar, PAX
 * x/g records, GNU L/K, base-256 sizes). Python parity: this is the tarfile
 * stdlib seam of koyeb/sandbox/sync.py — ported because the SDK keeps zero
 * runtime dependencies.
 */

const encoder = new TextEncoder();

/** A stream from an async generator of byte chunks. */
async function* chunksOf(chunks: Uint8Array[]): AsyncGenerator<Uint8Array, void, unknown> {
  for (const chunk of chunks) yield chunk;
}

/** The member fixture every header test starts from. */
function member(overrides: Partial<UstarMember> = {}): UstarMember {
  return { name: 'a.txt', type: 'file', mode: 0o644, mtime: 1774590000, size: 5, ...overrides };
}

async function readAll(stream: AsyncGenerator<Uint8Array, void, unknown>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** Concatenate an archive's header blocks plus content + trailer. */
async function archiveBytes(
  entries: Array<{ member: UstarMember; content?: Uint8Array }>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const { member: m, content } of entries) {
    for (const block of ustarHeaders(m)) parts.push(block);
    if (m.type === 'file') {
      if (content === undefined) throw new Error('file member needs content');
      parts.push(content);
      const padding = (BLOCK_SIZE - (content.length % BLOCK_SIZE)) % BLOCK_SIZE;
      if (padding > 0) parts.push(new Uint8Array(padding));
    }
  }
  parts.push(ustarTrailer());
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Read every member of an archive-shaped byte stream. */
async function readMembers(bytes: Uint8Array) {
  const reader = new UstarReader(chunksOf([bytes]));
  const out: Array<Record<string, unknown>> = [];
  for (;;) {
    const entry = await reader.next();
    if (entry === null) break;
    const content: Uint8Array[] = [];
    for await (const chunk of reader.content()) content.push(chunk);
    const joined = new Uint8Array(content.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of content) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    out.push({ ...entry, content: entry.size > 0 ? joined : undefined });
  }
  return out;
}

describe('ustarHeaders', () => {
  it('round-trips a regular file member through the reader', async () => {
    const bytes = await archiveBytes([{ member: member(), content: encoder.encode('hello') }]);

    const [header] = await readMembers(bytes);
    expect(header).toMatchObject({
      name: 'a.txt',
      typeflag: '0',
      mode: 0o644,
      mtime: 1774590000,
      size: 5,
      linkname: '',
    });
  });

  it('pins the ustar magic, version and octal fields', async () => {
    const blocks = ustarHeaders(member());
    expect(blocks).toHaveLength(1);
    const header = blocks[0];
    expect(header).toHaveLength(BLOCK_SIZE);
    // name field, NUL-padded
    expect(new TextDecoder().decode(header.subarray(0, 8))).toBe('a.txt\0\0\0');
    // mode: 7 octal digits + NUL
    expect(new TextDecoder().decode(header.subarray(100, 108))).toBe('0000644\0');
    // uid/gid: zero (owners are not kept)
    expect(new TextDecoder().decode(header.subarray(108, 124))).toBe('0000000\0' + '0000000\0');
    // size: 11 octal digits + NUL
    expect(new TextDecoder().decode(header.subarray(124, 136))).toBe('00000000005\0');
    // mtime: 11 octal digits + NUL
    expect(new TextDecoder().decode(header.subarray(136, 148))).toBe('15161414060\0');
    // typeflag: regular
    expect(String.fromCharCode(header[156])).toBe('0');
    // magic + version: POSIX ustar
    expect(new TextDecoder().decode(header.subarray(257, 265))).toBe('ustar\0' + '00');
  });

  it('writes a checksum the round-trip validates', async () => {
    // The checksum is the header's only self-validating field; a wrong one
    // must fail the read loudly (the reader rejects corrupt archives).
    const good = await archiveBytes([{ member: member(), content: encoder.encode('hello') }]);
    await expect(readMembers(good)).resolves.toHaveLength(1);

    const bad = new Uint8Array(good);
    bad[0] = 0x7a; // corrupt the name: checksum no longer matches
    await expect(readMembers(bad)).rejects.toThrow(/checksum/i);
  });

  it('marks directories with typeflag 5 and symlinks with 2', async () => {
    const bytes = await archiveBytes([
      { member: member({ name: 'sub', type: 'dir', size: 0, mode: 0o755 }) },
      { member: member({ name: 'link', type: 'symlink', size: 0, linkname: 'a.txt' }) },
    ]);

    const members = await readMembers(bytes);
    expect(members[0]).toMatchObject({ name: 'sub', typeflag: '5', size: 0 });
    expect(members[1]).toMatchObject({ name: 'link', typeflag: '2', linkname: 'a.txt' });
  });
});

describe('long names and links', () => {
  const segment = 'd'.repeat(40);

  it('splits names that pass 100 into the ustar prefix field', async () => {
    const name = [segment, segment, segment, 'leaf.txt'].join('/'); // 131 chars, > 100
    const blocks = ustarHeaders(member({ name, type: 'dir', size: 0 }));
    expect(blocks).toHaveLength(1); // pure ustar: no GNU extension needed
    const members = await readMembers(await archiveBytes([{ member: member({ name, type: 'dir', size: 0 }) }]));
    expect(members[0]).toMatchObject({ name, typeflag: '5' });
  });

  it('emits a GNU L entry for names no prefix split can carry', async () => {
    // A single path component beyond 100 chars has no '/' to split at.
    const name = 'n'.repeat(180);
    const blocks = ustarHeaders(member({ name, type: 'dir', size: 0 }));
    // The extension's header, its padded content, then the real header.
    expect(blocks).toHaveLength(3);
    expect(String.fromCharCode(blocks[0][156])).toBe('L');
    const members = await readMembers(await archiveBytes([{ member: member({ name, type: 'dir', size: 0 }) }]));
    expect(members[0]).toMatchObject({ name, typeflag: '5' });
  });

  it('emits a GNU K entry for long symlink targets', async () => {
    const target = `../${'t'.repeat(140)}`;
    const blocks = ustarHeaders(member({ name: 'link', type: 'symlink', size: 0, linkname: target }));
    expect(blocks).toHaveLength(3); // K header, padded content, real header
    expect(String.fromCharCode(blocks[0][156])).toBe('K');
    const members = await readMembers(
      await archiveBytes([{ member: member({ name: 'link', type: 'symlink', size: 0, linkname: target }) }]),
    );
    expect(members[0]).toMatchObject({ name: 'link', linkname: target });
  });

  it('round-trips a deep tree through writer and reader', async () => {
    const deep = ['l1', 'l2', 'l3', 'l4', 'l5', 'leaf.bin'].join('/');
    const bytes = await archiveBytes([{ member: member({ name: deep, size: 1 }), content: encoder.encode('x') }]);
    const members = await readMembers(bytes);
    expect(members[0]).toMatchObject({ name: deep, size: 1 });
  });
});

describe('UstarReader', () => {
  /** A raw 512-byte header from explicit fields, for executor-shaped input.
   *  sizeBytes mutates the raw size field before the checksum is summed. */
  function rawHeader(fields: {
    name: string;
    typeflag: string;
    size?: string;
    sizeBytes?: (field: Uint8Array) => void;
    mtime?: string;
    mode?: string;
    prefix?: string;
    linkname?: string;
    magic?: string;
  }): Uint8Array {
    const header = new Uint8Array(BLOCK_SIZE);
    const put = (offset: number, bytes: Uint8Array | string) =>
      header.set(typeof bytes === 'string' ? encoder.encode(bytes) : bytes, offset);
    put(0, fields.name);
    put(100, fields.mode ?? '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    if (fields.sizeBytes !== undefined) {
      const sizeField = new Uint8Array(12);
      fields.sizeBytes(sizeField);
      put(124, sizeField);
    } else {
      put(124, fields.size ?? '00000000000\0');
    }
    put(136, fields.mtime ?? '00000000000\0');
    // checksum left as spaces for the caller to fill
    header.fill(0x20, 148, 156);
    header[156] = fields.typeflag.charCodeAt(0);
    put(157, fields.linkname ?? '');
    put(257, fields.magic ?? 'ustar\0' + '00');
    if (fields.prefix !== undefined) put(345, fields.prefix);
    let sum = 0;
    for (const byte of header) sum += byte;
    const checksum = sum.toString(8).padStart(6, '0');
    put(148, checksum + '\0 ');
    return header;
  }

  async function rawArchive(parts: Uint8Array[]): Promise<Uint8Array> {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function padded(bytes: Uint8Array): Uint8Array {
    const padding = (BLOCK_SIZE - (bytes.length % BLOCK_SIZE)) % BLOCK_SIZE;
    const out = new Uint8Array(bytes.length + padding);
    out.set(bytes);
    return out;
  }

  it('reads the ustar prefix field as part of the name', async () => {
    const header = rawHeader({ name: 'leaf.txt', prefix: 'deep/dir', typeflag: '0', size: '00000000001\0' });
    const content = padded(encoder.encode('x'));
    const bytes = await rawArchive([header, content, ustarTrailer()]);
    const members = await readMembers(bytes);
    expect(members[0]).toMatchObject({ name: 'deep/dir/leaf.txt', size: 1 });
  });

  it('accepts GNU magic without a prefix field', async () => {
    const header = rawHeader({ name: 'a.txt', typeflag: '0', magic: 'ustar  \0' });
    const bytes = await rawArchive([header, ustarTrailer()]);
    const members = await readMembers(bytes);
    expect(members[0]).toMatchObject({ name: 'a.txt' });
  });

  it('applies PAX x records to the member that follows', async () => {
    // The length prefix counts the whole record, digits and terminator included.
    const pax = '22 path=long-name.txt\n';
    const paxBytes = padded(encoder.encode(pax));
    const paxHeader = rawHeader({
      name: 'PaxHeader',
      typeflag: 'x',
      size: paxBytes.length.toString(8).padStart(11, '0') + '\0',
    });
    const memberHeader = rawHeader({ name: 'short', typeflag: '0', size: '00000000001\0' });
    const content = padded(encoder.encode('x'));
    const bytes = await rawArchive([paxHeader, paxBytes, memberHeader, content, ustarTrailer()]);
    const members = await readMembers(bytes);
    expect(members[0]).toMatchObject({ name: 'long-name.txt', size: 1 });
  });

  it('applies PAX float mtimes and sizes', async () => {
    const pax = '30 mtime=1730123456.500000000\n';
    const paxBytes = padded(encoder.encode(pax));
    const paxHeader = rawHeader({
      name: 'PaxHeader',
      typeflag: 'x',
      size: paxBytes.length.toString(8).padStart(11, '0') + '\0',
    });
    const memberHeader = rawHeader({ name: 'a.txt', typeflag: '0' });
    const bytes = await rawArchive([paxHeader, paxBytes, memberHeader, ustarTrailer()]);
    const members = await readMembers(bytes);
    expect(members[0]).toMatchObject({ name: 'a.txt', mtime: 1730123456.5 });
  });

  it('applies PAX global records to every following member', async () => {
    const pax = '16 linkpath=tgt\n';
    const paxBytes = padded(encoder.encode(pax));
    const globalHeader = rawHeader({
      name: 'PaxHeader',
      typeflag: 'g',
      size: paxBytes.length.toString(8).padStart(11, '0') + '\0',
    });
    const first = rawHeader({ name: 'l1', typeflag: '2' });
    const second = rawHeader({ name: 'l2', typeflag: '2' });
    const bytes = await rawArchive([globalHeader, paxBytes, first, second, ustarTrailer()]);
    const members = await readMembers(bytes);
    expect(members[0]).toMatchObject({ name: 'l1', linkname: 'tgt' });
    expect(members[1]).toMatchObject({ name: 'l2', linkname: 'tgt' });
  });

  it('reads GNU L long-name entries', async () => {
    const long = 'x'.repeat(150);
    const nameBytes = padded(encoder.encode(long + '\0'));
    const lHeader = rawHeader({
      name: '././@LongLink',
      typeflag: 'L',
      size: nameBytes.length.toString(8).padStart(11, '0') + '\0',
    });
    const memberHeader = rawHeader({ name: 'truncated', typeflag: '0', size: '00000000001\0' });
    const content = padded(encoder.encode('x'));
    const bytes = await rawArchive([lHeader, nameBytes, memberHeader, content, ustarTrailer()]);
    const members = await readMembers(bytes);
    expect(members[0]).toMatchObject({ name: long, size: 1 });
  });

  it('decodes base-256 (binary) sizes the GNU writers emit for huge files', async () => {
    const size = 2 ** 40;
    const header = rawHeader({
      name: 'big.bin',
      typeflag: '0',
      sizeBytes(field) {
        // GNU base-256: the high bit flags binary, the rest is big-endian.
        field[0] = 0x80;
        let rest = size;
        for (let i = 11; i >= 1; i--) {
          field[i] = rest % 256;
          rest = Math.floor(rest / 256);
        }
      },
    });
    // The member's content is not in the archive — only the parsed size is
    // pinned here, so the content is never drained.
    const reader = new UstarReader(chunksOf([await rawArchive([header, ustarTrailer()])]));
    const entry = await reader.next();
    expect(entry).toMatchObject({ name: 'big.bin', size });
  });

  it('ends at the first zero block and drains unknown member types', async () => {
    const fifo = rawHeader({ name: 'pipe', typeflag: '6', size: '00000000003\0' });
    const fifoContent = padded(encoder.encode('abc'));
    const regular = rawHeader({ name: 'after', typeflag: '0', size: '00000000001\0' });
    const afterContent = padded(encoder.encode('z'));
    const bytes = await rawArchive([fifo, fifoContent, regular, afterContent, ustarTrailer()]);
    const members = await readMembers(bytes);
    expect(members[0]).toMatchObject({ name: 'pipe', typeflag: '6' });
    expect(members[1]).toMatchObject({ name: 'after', size: 1 });
  });

  it('refuses a header whose checksum does not match', async () => {
    const header = rawHeader({ name: 'a.txt', typeflag: '0' });
    header[0] = 0x62; // corrupt after checksumming
    await expect(readMembers(await rawArchive([header, ustarTrailer()]))).rejects.toThrow(/checksum/i);
  });

  it('parses entries split across arbitrary stream chunk boundaries', async () => {
    const bytes = await archiveBytes([
      { member: member({ name: 'a.txt' }), content: encoder.encode('hello') },
      { member: member({ name: 'b.txt' }), content: encoder.encode('world!!') },
    ]);
    // One-byte-ish chunks: every boundary position gets exercised.
    const reader = new UstarReader((async function* () {
      for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, Math.min(i + 3, bytes.length));
    })());
    const names: string[] = [];
    for (;;) {
      const entry = await reader.next();
      if (entry === null) break;
      for await (const _chunk of reader.content()) void _chunk;
      names.push(entry.name);
    }
    expect(names).toEqual(['a.txt', 'b.txt']);
  });
});

describe('ustarTrailer', () => {
  it('is two zero blocks', () => {
    const trailer = ustarTrailer();
    expect(trailer).toHaveLength(2 * BLOCK_SIZE);
    expect(trailer.every((byte) => byte === 0)).toBe(true);
  });
});
