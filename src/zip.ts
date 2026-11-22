/**
 * A minimal ZIP writer: files are stored uncompressed (audio barely
 * compresses), with UTF-8 names and a CRC-32 each. The archive is a Blob that
 * references the files' own Blobs, so their data is never copied in memory.
 *
 * Format reference: PKWARE APPNOTE.TXT, sections 4.3–4.4.
 */

export interface ZipEntry {
  name: string;
  data: Blob;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Updates a running CRC-32 (start with 0) with `bytes`. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

/** CRC-32 of a Blob, read in chunks so the whole file is never in memory. */
export async function crc32OfBlob(blob: Blob): Promise<number> {
  const reader = blob.stream().getReader();
  let crc = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32(value, crc);
  }
}

/** Date and time in MS-DOS format, as ZIP headers store them. */
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) |
      (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const UTF8_NAMES = 0x0800;
const VERSION = 20;
const MAX_SIZE = 0xffffffff;

/** Builds a ZIP archive of `entries`, all stored with the time `modified`. */
export async function createZip(
  entries: ZipEntry[],
  modified = new Date(),
): Promise<Blob> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const size = entry.data.size;
    if (size > MAX_SIZE || offset > MAX_SIZE) {
      throw new Error("The export is too large for a ZIP archive.");
    }
    const crc = await crc32OfBlob(entry.data);

    const local = new Uint8Array(30 + name.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, VERSION, true);
    header.setUint16(6, UTF8_NAMES, true);
    header.setUint16(8, 0, true); // stored
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, size, true);
    header.setUint32(22, size, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true);
    local.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const entryView = new DataView(record.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, VERSION, true);
    entryView.setUint16(6, VERSION, true);
    entryView.setUint16(8, UTF8_NAMES, true);
    entryView.setUint16(10, 0, true);
    entryView.setUint16(12, time, true);
    entryView.setUint16(14, date, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, size, true);
    entryView.setUint32(24, size, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint32(42, offset, true);
    record.set(name, 46);

    parts.push(local, entry.data);
    central.push(record);
    offset += local.length + size;
  }

  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  if (offset > MAX_SIZE || entries.length > 0xffff) {
    throw new Error("The export is too large for a ZIP archive.");
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

/** A file read from a ZIP archive: its data is a slice of the archive. */
export interface ZipFile extends ZipEntry {
  /** CRC-32 recorded in the archive, to check the data against. */
  crc: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

async function bytesAt(blob: Blob, start: number, length: number): Promise<DataView> {
  if (start < 0 || start + length > blob.size) throw new Error("truncated");
  return new DataView(await blob.slice(start, start + length).arrayBuffer());
}

/**
 * Lists the files of a ZIP archive whose files are stored uncompressed, as
 * `createZip` writes them. Nothing is read into memory but the headers: each
 * file's data is a slice of `archive`. Throws for archives that are damaged,
 * compressed, encrypted or ZIP64.
 */
export async function readZip(archive: Blob): Promise<ZipFile[]> {
  try {
    return await readZipEntries(archive);
  } catch (error) {
    if (error instanceof Error && error.message !== "truncated") throw error;
    throw new Error("The file is damaged or is not a ZIP archive.");
  }
}

async function readZipEntries(archive: Blob): Promise<ZipFile[]> {
  // The end record is the last thing in the file, before an optional comment.
  const tailStart = Math.max(0, archive.size - EOCD_SIZE - MAX_COMMENT);
  const tail = await bytesAt(archive, tailStart, archive.size - tailStart);
  let end = -1;
  for (let i = tail.byteLength - EOCD_SIZE; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIGNATURE) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("truncated");
  const count = tail.getUint16(end + 10, true);
  const centralSize = tail.getUint32(end + 12, true);
  const centralOffset = tail.getUint32(end + 16, true);
  if (count === 0xffff || centralOffset === MAX_SIZE) {
    throw new Error("ZIP64 archives are not supported.");
  }
  const central = await bytesAt(archive, centralOffset, centralSize);
  const decoder = new TextDecoder();
  const files: ZipFile[] = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > central.byteLength || central.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new Error("truncated");
    }
    const flags = central.getUint16(at + 8, true);
    const method = central.getUint16(at + 10, true);
    const crc = central.getUint32(at + 16, true);
    const compressedSize = central.getUint32(at + 20, true);
    const size = central.getUint32(at + 24, true);
    const nameLength = central.getUint16(at + 28, true);
    const extraLength = central.getUint16(at + 30, true);
    const commentLength = central.getUint16(at + 32, true);
    const localOffset = central.getUint32(at + 42, true);
    if (at + 46 + nameLength > central.byteLength) throw new Error("truncated");
    const name = decoder.decode(
      new Uint8Array(central.buffer, central.byteOffset + at + 46, nameLength),
    );
    if (flags & 0x1) throw new Error("Encrypted ZIP archives are not supported.");
    if (method !== 0 || compressedSize !== size) {
      throw new Error("Compressed ZIP archives are not supported.");
    }
    const local = await bytesAt(archive, localOffset, 30);
    if (local.getUint32(0, true) !== LOCAL_SIGNATURE) throw new Error("truncated");
    const start = localOffset + 30 + local.getUint16(26, true) +
      local.getUint16(28, true);
    if (start + size > archive.size) throw new Error("truncated");
    files.push({ name, data: archive.slice(start, start + size), crc });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
