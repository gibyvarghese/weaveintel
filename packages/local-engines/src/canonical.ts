// SPDX-License-Identifier: MIT
/**
 * Canonical JSON and SHA-256 over WebCrypto, so the issuing server and the browser hash the same bytes.
 *
 * Browser-safe: only `globalThis.crypto.subtle` and `TextEncoder`, both present in every current browser and in
 * Node 20 and later.
 */

/**
 * JSON with object keys sorted at every depth and no whitespace. Refuses values JSON cannot carry faithfully
 * (non-finite numbers, functions, symbols, bigints, `undefined` inside arrays), so two parties can never disagree
 * about what was hashed. Object properties whose value is `undefined` are left out, as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  return write(value, 'value');
}

function write(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`canonicalJson: ${path} is not a finite number`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, i) => {
            if (item === undefined)
              throw new TypeError(`canonicalJson: ${path}[${i}] is undefined`);
            return write(item, `${path}[${i}]`);
          })
          .join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: ${path} is not a plain object`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write(record[k], `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${path} has unsupported type ${typeof value}`);
  }
}

function subtle(): SubtleCrypto {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s)
    throw new Error(
      'local-engines: WebCrypto (crypto.subtle) is not available in this environment',
    );
  return s;
}

/** Lower-case hex SHA-256 of a string (UTF-8) or of bytes. */
export async function sha256Hex(input: string | ArrayBuffer | ArrayBufferView): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : toUint8(input);
  const digest = await subtle().digest('SHA-256', bytes);
  return hex(new Uint8Array(digest));
}

/** Copy into a fresh `Uint8Array` backed by a plain `ArrayBuffer` (WebCrypto refuses shared buffers). */
export function toUint8(input: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  const view =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const out = new Uint8Array(new ArrayBuffer(view.byteLength));
  out.set(view);
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Base64url without padding (the form signatures travel in). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url (padding optional). Throws on characters outside the alphabet. */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new TypeError('base64url: invalid characters');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
