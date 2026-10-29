/**
 * A minimal ustar tar writer and reader — the tar half of sync()'s archive
 * batches (Python parity: this is the seam Python's tarfile stdlib covers).
 *
 * The writer produces what the executor's Go extractor reads: POSIX ustar
 * headers with octal fields, a `/`-boundary prefix split for names up to 255,
 * GNU L/K extension entries beyond that, whole-second mtimes, no owners.
 * The reader consumes what the executor's Go writer produces: ustar with
 * prefix, PAX x/g extended records (long names, float mtimes, big sizes),
 * GNU L/K entries, and base-256 (binary) numeric fields. Zero dependencies:
 * gzip is node:zlib's, called by sync.ts.
 */

export const BLOCK_SIZE = 512;

/** One member the writer serializes. */
export type UstarMember = {
  /** Archive-relative, /-separated; never absolute. */
  name: string;
  type: 'file' | 'dir' | 'symlink';
  /** Permission bits only (0o644). */
  mode: number;
  /** Whole seconds since the epoch — tar cannot carry more. */
  mtime: number;
  /** Content size; 0 for dirs and symlinks. */
  size: number;
  /** The symlink's target, stored byte-identical. */
  linkname?: string;
};

/** One member the reader parsed, before its content is consumed. */
export type UstarReadMember = {
  name: string;
  /** '0' regular, '5' dir, '2' symlink, '1' hardlink, '6' FIFO, ... */
  typeflag: string;
  mode: number;
  /** Seconds since the epoch; PAX records may carry a fraction. */
  mtime: number;
  size: number;
  linkname: string;
};

const TYPE_FLAGS: Record<UstarMember['type'], string> = { file: '0', dir: '5', symlink: '2' };
const encoder = new TextEncoder();

/** An octal field: `digits` octal digits, NUL-terminated. */
function octal(value: number, length: number): Uint8Array {
  if (value < 0) throw new Error(`tar fields cannot be negative: ${value}`);
  const text = value.toString(8).padStart(length - 1, '0') + '\0';
  const field = new Uint8Array(length);
  const bytes = encoder.encode(text);
  if (bytes.length > length) throw new Error(`value ${value} overflows a ${length}-byte tar field`);
  field.set(bytes);
  return field;
}

/** The checksum of a header: the sum with its checksum field as spaces. */
function headerChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

/** One 512-byte header block for a member, prefix included. */
function headerBlock(member: UstarMember, name: string, linkname: string, prefix = ''): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const put = (offset: number, bytes: Uint8Array) => {
    if (offset + bytes.length > BLOCK_SIZE) throw new Error('tar header field overflow');
    header.set(bytes, offset);
  };
  const putText = (offset: number, text: string, length: number) => {
    const bytes = encoder.encode(text);
    if (bytes.length > length) throw new Error(`tar field overflow: ${text}`);
    const field = new Uint8Array(length);
    field.set(bytes);
    put(offset, field);
  };

  putText(0, name, 100);
  if (prefix !== '') putText(345, prefix, 155);
  put(100, octal(member.mode, 8));
  put(108, octal(0, 8)); // uid: owners are not kept
  put(116, octal(0, 8)); // gid
  put(124, octal(member.size, 12));
  put(136, octal(member.mtime, 12));
  header.fill(0x20, 148, 156); // checksum: spaces while summing
  header[156] = TYPE_FLAGS[member.type].charCodeAt(0);
  putText(157, linkname, 100);
  putText(257, 'ustar\0', 6);
  putText(263, '00', 2);

  const checksum = headerChecksum(header);
  put(148, encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '));

  return header;
}

/** The longest name one ustar header can carry, via its prefix field. */
function splitUstarName(name: string): { name: string; prefix: string } | null {
  const bytes = encoder.encode(name);
  if (bytes.length <= 100) return { name, prefix: '' };
  if (bytes.length > 255) return null;
  // Split at a / boundary: prefix ≤ 155, the rest ≤ 100. The earliest valid
  // split keeps the longest suffix, so a split exists whenever one can.
  for (let split = 1; split <= 155 && split < name.length; split++) {
    if (name.charCodeAt(split) !== 0x2f) continue; // '/'
    const prefix = name.slice(0, split);
    const rest = name.slice(split + 1);
    if (encoder.encode(prefix).length > 155 || encoder.encode(rest).length > 100) continue;
    return { name: rest, prefix };
  }
  return null;
}

/** A GNU L/K extension entry: `content` + NUL rides before the real header. */
function gnuExtension(
  kind: 'L' | 'K',
  content: string,
  mtime: number,
): { header: Uint8Array; content: Uint8Array } {
  const bytes = encoder.encode(content + '\0');
  const header = new Uint8Array(BLOCK_SIZE);
  const putText = (offset: number, text: string, length: number) => {
    const field = new Uint8Array(length);
    field.set(encoder.encode(text).subarray(0, length));
    header.set(field, offset);
  };
  putText(0, '././@LongLink', 100);
  header.set(octal(0o644, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  header.set(octal(bytes.length, 12), 124);
  header.set(octal(mtime, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = kind.charCodeAt(0);
  putText(257, 'ustar  \0', 8); // GNU magic
  const checksum = headerChecksum(header);
  const field = encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 ');
  header.set(field.subarray(0, 8), 148);
  return { header, content: padToBlock(bytes) };
}

/** Content bytes padded to the next block boundary. */
export function padToBlock(bytes: Uint8Array): Uint8Array {
  const padding = (BLOCK_SIZE - (bytes.length % BLOCK_SIZE)) % BLOCK_SIZE;
  if (padding === 0) return bytes;
  const out = new Uint8Array(bytes.length + padding);
  out.set(bytes);
  return out;
}

/**
 * The header blocks of one member — its own header, plus the GNU L/K
 * extension entries a long name or link target needs. Content follows from
 * the caller, padded to a block boundary (padToBlock).
 */
export function ustarHeaders(member: UstarMember): Uint8Array[] {
  const linkname = member.linkname ?? '';
  const linkBytes = encoder.encode(linkname);

  if (linkBytes.length > 100) {
    const { header, content } = gnuExtension('K', linkname, member.mtime);
    return [header, content, headerBlock(member, member.name.slice(0, 100), linkname.slice(0, 100))];
  }

  const split = splitUstarName(member.name);
  if (split === null) {
    const { header, content } = gnuExtension('L', member.name, member.mtime);
    return [header, content, headerBlock(member, member.name.slice(0, 100), linkname)];
  }

  return [headerBlock(member, split.name, linkname, split.prefix)];
}

/** The two zero blocks that end every archive. */
export function ustarTrailer(): Uint8Array {
  return new Uint8Array(2 * BLOCK_SIZE);
}

// ---------------------------------------------------------------------------
// Reader

/** A buffered reader over chunked byte streams: reads exactly N bytes. */
class ByteReader {
  private buffer = new Uint8Array(0);
  private done = false;

  constructor(private readonly stream: AsyncIterable<Uint8Array>) {}

  /** Read exactly length bytes; null at the archive's end. */
  async readExact(length: number): Promise<Uint8Array | null> {
    while (this.buffer.length < length) {
      if (this.done) return null;
      const { value, done } = await this.stream[Symbol.asyncIterator]().next();
      if (done) {
        this.done = true;
        continue;
      }
      if (value.length === 0) continue;
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
    }
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  /** Whether the stream has more buffered bytes (a truncation check). */
  atEnd(): boolean {
    return this.done && this.buffer.length === 0;
  }
}

/** An ASCII field's octal value, NUL- or space-terminated. */
function parseOctal(field: Uint8Array): number {
  let text = '';
  for (const byte of field) {
    if (byte === 0 || byte === 0x20) break;
    text += String.fromCharCode(byte);
  }
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value)) throw new Error('malformed octal field in tar header');
  return value;
}

/** A numeric field in GNU's base-256 encoding (high bit set on the first byte). */
function parseBase256(field: Uint8Array): number {
  let value = field[0] & 0x7f;
  for (let i = 1; i < field.length; i++) {
    value = value * 256 + field[i];
  }
  return value;
}

function parseNumeric(field: Uint8Array): number {
  return (field[0] & 0x80) !== 0 ? parseBase256(field) : parseOctal(field);
}

function fieldText(field: Uint8Array): string {
  let end = field.indexOf(0);
  if (end === -1) end = field.length;
  return new TextDecoder().decode(field.subarray(0, end));
}

/** The records of a PAX extended header: `<len> <key>=<value>\n` repeated. */
function parsePaxRecords(content: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const text = new TextDecoder().decode(content);
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(' ', at);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(at, space), 10);
    if (!Number.isInteger(length) || length <= 0) throw new Error('malformed PAX record');
    const record = text.slice(at, at + length);
    const equals = record.indexOf('=');
    const newline = record.indexOf('\n');
    if (equals === -1 || newline === -1) throw new Error('malformed PAX record');
    records.set(record.slice(record.indexOf(' ') + 1, equals), record.slice(equals + 1, newline));
    at += length;
  }
  return records;
}

/**
 * Reads members off a gunzipped tar stream: headers through ustar prefix,
 * GNU L/K and PAX x/g shapes, whole archives end at the first zero block.
 *
 * Each member's content is consumed through content(); the next() call
 * drains whatever a previous member left, so a skipped member can never
 * desynchronize the header stream.
 */
export class UstarReader {
  private readonly bytes: ByteReader;
  private pendingContent = 0;
  private pendingPadding = 0;
  private globalPax = new Map<string, string>();
  private overrideName: string | undefined;
  private overrideLink: string | undefined;
  private overrideMtime: number | undefined;
  private overrideSize: number | undefined;

  constructor(stream: AsyncIterable<Uint8Array>) {
    this.bytes = new ByteReader(stream);
  }

  /** The next member, or null at the archive's end. */
  async next(): Promise<UstarReadMember | null> {
    await this.drain();

    const header = await this.bytes.readExact(BLOCK_SIZE);
    if (header === null) throw new Error('tar stream ended without a trailer');
    if (header.every((byte) => byte === 0)) return null; // the trailer's first zero block

    const checksum = parseOctal(header.subarray(148, 156));
    if (checksum !== headerChecksum(header)) {
      throw new Error('tar header checksum mismatch');
    }

    const typeflag = String.fromCharCode(header[156]);
    const size = parseNumeric(header.subarray(124, 136));

    if (typeflag === 'L' || typeflag === 'K') {
      const content = await this.readRaw(size, paddingFor(size));
      const text = fieldText(content);
      if (typeflag === 'L') this.overrideName = text;
      else this.overrideLink = text;
      return this.next();
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const records = parsePaxRecords(await this.readRaw(size, paddingFor(size)));
      if (typeflag === 'g') {
        this.globalPax = records;
      } else {
        if (records.has('path')) this.overrideName = records.get('path');
        if (records.has('linkpath')) this.overrideLink = records.get('linkpath');
        if (records.has('mtime')) this.overrideMtime = Number.parseFloat(records.get('mtime')!);
        if (records.has('size')) this.overrideSize = Number.parseInt(records.get('size')!, 10);
      }
      return this.next();
    }

    let name = fieldText(header.subarray(0, 100));
    const magic = fieldText(header.subarray(257, 263));
    if (magic === 'ustar') {
      const version = fieldText(header.subarray(263, 265));
      if (version === '00') {
        const prefix = fieldText(header.subarray(345, 500));
        if (prefix !== '') name = `${prefix}/${name}`;
      }
    }
    if (this.overrideName !== undefined) {
      name = this.overrideName;
      this.overrideName = undefined;
    }
    if (this.globalPax.has('path')) name = this.globalPax.get('path')!;

    let linkname = fieldText(header.subarray(157, 257));
    if (this.overrideLink !== undefined) {
      linkname = this.overrideLink;
      this.overrideLink = undefined;
    }
    if (this.globalPax.has('linkpath')) linkname = this.globalPax.get('linkpath')!;

    let mtime = parseNumeric(header.subarray(136, 148));
    if (this.overrideMtime !== undefined) {
      mtime = this.overrideMtime;
      this.overrideMtime = undefined;
    }
    if (this.globalPax.has('mtime')) mtime = Number.parseFloat(this.globalPax.get('mtime')!);

    let resolvedSize = size;
    if (this.overrideSize !== undefined) {
      resolvedSize = this.overrideSize;
      this.overrideSize = undefined;
    }
    if (this.globalPax.has('size')) {
      resolvedSize = Number.parseInt(this.globalPax.get('size')!, 10);
    }
    this.pendingContent = resolvedSize;
    this.pendingPadding = paddingFor(resolvedSize);

    return {
      name,
      typeflag,
      mode: parseOctal(header.subarray(100, 108)),
      mtime,
      size: resolvedSize,
      linkname,
    };
  }

  /** The current member's content, chunk by chunk — padding consumed silently. */
  async *content(): AsyncGenerator<Uint8Array, void, unknown> {
    while (this.pendingContent > 0) {
      const wanted = Math.min(this.pendingContent, 1 << 20);
      const chunk = await this.bytes.readExact(wanted);
      if (chunk === null) throw new Error('tar stream ended mid-member');
      this.pendingContent -= chunk.length;
      yield chunk;
    }
    await this.consumePadding();
  }

  /** Drain the current member's remaining content (skipping a member). */
  async drain(): Promise<void> {
    while (this.pendingContent > 0) {
      const chunk = await this.bytes.readExact(Math.min(this.pendingContent, 1 << 20));
      if (chunk === null) throw new Error('tar stream ended mid-member');
      this.pendingContent -= chunk.length;
    }
    await this.consumePadding();
  }

  /** The block padding after the content — part of the member, never yielded. */
  private async consumePadding(): Promise<void> {
    if (this.pendingPadding === 0) return;
    const padding = await this.bytes.readExact(this.pendingPadding);
    this.pendingPadding = 0;
    if (padding === null) throw new Error('tar stream ended mid-member');
  }

  /** Read a header's content plus its block padding in one go (L/K/x/g). */
  private async readRaw(size: number, padding: number): Promise<Uint8Array> {
    const whole = await this.bytes.readExact(size + padding);
    if (whole === null) throw new Error('tar stream ended mid-member');
    return whole.subarray(0, size);
  }
}

/** The block padding after a member of `size` content bytes. */
function paddingFor(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}
