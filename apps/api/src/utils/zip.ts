import { Readable } from 'node:stream';

/**
 * Minimal streaming ZIP writer (APPNOTE.TXT compliant, store method, streaming
 * data descriptors). Entries are streamed one at a time so large archives never
 * need to be held fully in memory (PRD §5.5).
 */

const CRC32_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Incremental CRC-32 (bitwise reflected, standard ZIP polynomial). */
export class Crc32 {
  private value = 0xffffffff;

  update(chunk: Buffer): void {
    let c = this.value;
    for (let i = 0; i < chunk.length; i++) {
      c = CRC32_TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
    }
    this.value = c;
  }

  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

export interface ZipEntry {
  /** Path inside the archive, e.g. `docs/report.pdf`. */
  name: string;
  /** Lazily resolves the entry bytes or a stream (keeps memory bounded). */
  getData: () => Promise<Readable | Buffer>;
}

function newBuffer(size: number): Buffer {
  return Buffer.alloc(size);
}

function writeU32(buf: Buffer, offset: number, v: number): void {
  buf.writeUInt32LE(v >>> 0, offset);
}
function writeU16(buf: Buffer, offset: number, v: number): void {
  buf.writeUInt16LE(v & 0xffff, offset);
}

const FLAG = 0x0808; // bit 3: data descriptor, bit 11: UTF-8 names
const METHOD_STORE = 0;

/**
 * Async-generator producing a complete ZIP archive with correct absolute
 * offsets, computing per-entry CRC-32 as data passes through.
 */
export async function* zipChunks(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const now = dosDateTime(new Date());
  const central: { name: Buffer; crc: number; size: number; offset: number }[] = [];
  let streamOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 0xffff) throw new Error(`ZIP entry name too long: ${entry.name}`);
    const offset = streamOffset;

    // Local file header (sizes/crc zeroed; supplied via data descriptor).
    const lfh = newBuffer(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    writeU16(lfh, 4, 20);
    writeU16(lfh, 6, FLAG);
    writeU16(lfh, 8, METHOD_STORE);
    writeU16(lfh, 10, now.time);
    writeU16(lfh, 12, now.date);
    writeU32(lfh, 14, 0);
    writeU32(lfh, 18, 0);
    writeU32(lfh, 22, 0);
    writeU16(lfh, 26, name.length);
    writeU16(lfh, 28, 0);
    yield lfh;
    streamOffset += lfh.length;
    yield name;
    streamOffset += name.length;

    const crc = new Crc32();
    let size = 0;
    const data = await entry.getData();
    if (Buffer.isBuffer(data)) {
      crc.update(data);
      size += data.length;
      if (data.length > 0) {
        yield data;
        streamOffset += data.length;
      }
    } else {
      for await (const chunk of data) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        crc.update(buf);
        size += buf.length;
        if (buf.length > 0) {
          yield buf;
          streamOffset += buf.length;
        }
      }
    }

    const dd = newBuffer(16);
    dd.writeUInt32LE(0x08074b50, 0);
    writeU32(dd, 4, crc.digest());
    writeU32(dd, 8, size);
    writeU32(dd, 12, size);
    yield dd;
    streamOffset += dd.length;

    central.push({ name, crc: crc.digest(), size, offset });
  }

  const cdOffset = streamOffset;
  let cdSize = 0;
  for (const rec of central) {
    const cd = newBuffer(46);
    cd.writeUInt32LE(0x02014b50, 0);
    writeU16(cd, 4, 20);
    writeU16(cd, 6, 20);
    writeU16(cd, 8, FLAG);
    writeU16(cd, 10, METHOD_STORE);
    writeU16(cd, 12, now.time);
    writeU16(cd, 14, now.date);
    writeU32(cd, 16, rec.crc);
    writeU32(cd, 20, rec.size);
    writeU32(cd, 24, rec.size);
    writeU16(cd, 28, rec.name.length);
    writeU16(cd, 30, 0);
    writeU16(cd, 32, 0);
    writeU16(cd, 34, 0);
    writeU16(cd, 36, 0);
    writeU32(cd, 38, 0);
    writeU32(cd, 42, rec.offset);
    yield cd;
    cdSize += cd.length;
    yield rec.name;
    cdSize += rec.name.length;
  }

  const eocd = newBuffer(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  writeU16(eocd, 4, 0);
  writeU16(eocd, 6, 0);
  writeU16(eocd, 8, central.length);
  writeU16(eocd, 10, central.length);
  writeU32(eocd, 12, cdSize);
  writeU32(eocd, 16, cdOffset);
  writeU16(eocd, 20, 0);
  yield eocd;
}

/** Wraps the generator in a pull-based Readable without manual read() bookkeeping. */
export function zipStream(entries: ZipEntry[]): Readable {
  return Readable.from(zipChunks(entries));
}
