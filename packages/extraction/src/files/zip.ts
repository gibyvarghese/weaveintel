// SPDX-License-Identifier: MIT
/**
 * A small, read-only ZIP reader for DOCX and XLSX (both are ZIP files).
 *
 * In plain words: it reads the archive's table of contents and inflates only
 * the parts asked for, with `node:zlib` (no package needed). It refuses what a
 * "zip bomb" would need: too many entries, a huge total size, an extreme
 * compression ratio, an entry that inflates to more than it declared, ZIP64,
 * and encrypted entries. Nothing is ever written to disk.
 */

import { inflateRawSync } from 'node:zlib';
import { FileLimitError } from './errors.js';

export interface ZipLimits {
  /** Most entries in the archive. Default 2,000. */
  readonly maxEntries?: number;
  /** Most bytes all entries may inflate to, as declared. Default 200 MiB. */
  readonly maxTotalBytes?: number;
  /** Most bytes one entry may inflate to. Default 64 MiB. */
  readonly maxEntryBytes?: number;
  /** Highest inflated:compressed ratio for any entry larger than 1 MiB. Default 100. */
  readonly maxRatio?: number;
}

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly size: number;
  readonly method: number;
  readonly encrypted: boolean;
  readonly localOffset: number;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
  has(name: string): boolean;
  /** Inflate one entry. Throws `FileLimitError` if it inflates past what it declared or the limits. */
  read(name: string): Uint8Array;
  readText(name: string): string;
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** True when the bytes start like a ZIP file. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);
}

export function readZip(bytes: Uint8Array, limits: ZipLimits = {}): ZipArchive {
  const maxEntries = limits.maxEntries ?? 2000;
  const maxTotal = limits.maxTotalBytes ?? 200 * 1024 * 1024;
  const maxEntry = limits.maxEntryBytes ?? 64 * 1024 * 1024;
  const maxRatio = limits.maxRatio ?? 100;

  // End of central directory: the last 22..65,557 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FileLimitError('zip_malformed', 'The file is not a readable ZIP archive (no table of contents).');
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new FileLimitError('zip64_refused', 'ZIP64 archives are not accepted.');
  }
  if (count > maxEntries) throw new FileLimitError('zip_too_many_entries', `The archive has ${count} entries; at most ${maxEntries} are accepted.`);
  if (cdOffset + cdSize > bytes.length) throw new FileLimitError('zip_malformed', 'The ZIP table of contents points outside the file.');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== 0x02014b50) throw new FileLimitError('zip_malformed', 'The ZIP table of contents is damaged.');
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new FileLimitError('zip64_refused', 'ZIP64 entries are not accepted.');
    }
    if (size > maxEntry) throw new FileLimitError('zip_entry_too_large', `"${name}" would inflate to ${size} bytes; at most ${maxEntry} are accepted.`);
    if (size > 1024 * 1024 && compressedSize > 0 && size / compressedSize > maxRatio) {
      throw new FileLimitError('zip_ratio', `"${name}" is compressed ${Math.round(size / compressedSize)}:1; at most ${maxRatio}:1 is accepted.`);
    }
    total += size;
    if (total > maxTotal) throw new FileLimitError('zip_too_large', `The archive would inflate to more than ${maxTotal} bytes.`);
    entries.push({ name, compressedSize, size, method, encrypted: (flags & 1) === 1, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));

  function read(name: string): Uint8Array {
    const e = byName.get(name);
    if (!e) throw new FileLimitError('zip_entry_missing', `The archive has no "${name}".`);
    if (e.encrypted) throw new FileLimitError('zip_encrypted', `"${name}" is encrypted and cannot be read.`);
    const lo = e.localOffset;
    if (u32(bytes, lo) !== 0x04034b50) throw new FileLimitError('zip_malformed', `The entry "${name}" is damaged.`);
    const start = lo + 30 + u16(bytes, lo + 26) + u16(bytes, lo + 28);
    const data = bytes.subarray(start, start + e.compressedSize);
    if (e.method === 0) {
      if (e.compressedSize !== e.size) throw new FileLimitError('zip_malformed', `The stored entry "${name}" has inconsistent sizes.`);
      return data;
    }
    if (e.method !== 8) throw new FileLimitError('zip_method', `"${name}" uses a compression method (${e.method}) that is not accepted.`);
    try {
      // The output cap is the DECLARED size: an entry that lies about its size fails here.
      const out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
      if (out.length !== e.size) throw new Error('size mismatch');
      return new Uint8Array(out.buffer, out.byteOffset, out.length);
    } catch {
      throw new FileLimitError('zip_entry_lied', `"${name}" did not inflate to the size it declared.`);
    }
  }

  return {
    entries,
    has: (name) => byName.has(name),
    read,
    readText: (name) => decoder.decode(read(name)),
  };
}

/** Build a ZIP in memory (stored or deflated). For tests and fixtures; never used on untrusted input. */
export async function writeZip(files: Readonly<Record<string, string | Uint8Array>>, opts?: { deflate?: boolean }): Promise<Uint8Array> {
  const { deflateRawSync, crc32 } = await import('node:zlib');
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === 'string' ? enc.encode(content) : content;
    const data = opts?.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const method = opts?.deflate ? 8 : 0;
    const crc = crc32(raw) >>> 0;
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, method, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, raw.length, true);
    dv.setUint16(26, nameBytes.length, true); local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true); central.set(nameBytes, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, centrals.length, true); ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
