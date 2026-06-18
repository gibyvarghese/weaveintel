/**
 * @weaveintel/encryption — AEAD envelope codec.
 *
 * Sentinel format: `enc:v1:<epoch>:<iv_b64>:<ct_b64>` where
 *   - `epoch` is the DEK epoch (integer, monotonic per tenant)
 *   - `iv` is a 12-byte random IV (96 bits, base64)
 *   - `ct` is the AES-256-GCM ciphertext concatenated with the 16-byte auth tag (base64)
 *
 * AAD is `tenant|table|column|rowId|epoch` and is required on both encrypt
 * and decrypt; mismatch fails closed.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AeadError, CiphertextFormatError } from './errors.js';

/** Sentinel prefix that discriminates encrypted blobs from plaintext. */
export const SENTINEL_PREFIX = 'enc:v1:';
export const ENVELOPE_VERSION = 'v1';

const IV_LENGTH = 12; // 96-bit IV per NIST SP 800-38D
const AUTH_TAG_LENGTH = 16; // 128-bit tag

export interface EnvelopeAadParts {
  readonly tenantId: string;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
  readonly epoch: number;
}

export interface EncryptArgs {
  readonly plaintext: Buffer;
  readonly dek: Buffer; // 32 bytes
  readonly aad: EnvelopeAadParts;
}

export interface DecryptArgs {
  /** Sentinel-prefixed ciphertext string. */
  readonly ciphertext: string;
  /** DEK matching the parsed epoch. */
  readonly dek: Buffer;
  /** AAD parts. `epoch` here MUST match the parsed epoch from the ciphertext. */
  readonly aad: Omit<EnvelopeAadParts, 'epoch'>;
}

export interface ParsedSentinel {
  readonly version: 'v1';
  readonly epoch: number;
  readonly iv: Buffer;
  readonly ctWithTag: Buffer;
}

/**
 * Serialize AAD parts into the canonical `tenant|table|column|rowId|epoch` buffer.
 * @internal Not part of the public API — used by encryptValue/decryptValue internally.
 */
export function buildAad(parts: EnvelopeAadParts): Buffer {
  return Buffer.from(
    `${parts.tenantId}|${parts.table}|${parts.column}|${parts.rowId}|${parts.epoch}`,
    'utf8',
  );
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SENTINEL_PREFIX);
}

/**
 * Parse a sentinel-prefixed ciphertext string into its component parts.
 * @internal Not part of the public API — used by decryptValue and the rewrite scheduler.
 */
export function parseSentinel(s: string): ParsedSentinel {
  if (!s.startsWith(SENTINEL_PREFIX)) {
    throw new CiphertextFormatError('not a sentinel-prefixed ciphertext');
  }
  // enc:v1:<epoch>:<iv>:<ct>
  const rest = s.slice(SENTINEL_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new CiphertextFormatError(`expected 3 segments after enc:v1: prefix, got ${parts.length}`);
  }
  const [epochStr, ivB64, ctB64] = parts as [string, string, string];
  const epoch = Number.parseInt(epochStr, 10);
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new CiphertextFormatError(`invalid epoch '${epochStr}'`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const ctWithTag = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LENGTH) {
    throw new CiphertextFormatError(`invalid iv length ${iv.length}, expected ${IV_LENGTH}`);
  }
  if (ctWithTag.length < AUTH_TAG_LENGTH) {
    throw new CiphertextFormatError('ciphertext shorter than auth tag');
  }
  return { version: 'v1', epoch, iv, ctWithTag };
}

export function encryptValue(args: EncryptArgs): string {
  if (args.dek.length !== 32) {
    throw new AeadError(`DEK must be 32 bytes, got ${args.dek.length}`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', args.dek, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(buildAad(args.aad));
  const ct = Buffer.concat([cipher.update(args.plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ctWithTag = Buffer.concat([ct, tag]);
  return `${SENTINEL_PREFIX}${args.aad.epoch}:${iv.toString('base64')}:${ctWithTag.toString('base64')}`;
}

export function decryptValue(args: DecryptArgs): Buffer {
  if (args.dek.length !== 32) {
    throw new AeadError(`DEK must be 32 bytes, got ${args.dek.length}`);
  }
  const parsed = parseSentinel(args.ciphertext);
  const ct = parsed.ctWithTag.subarray(0, parsed.ctWithTag.length - AUTH_TAG_LENGTH);
  const tag = parsed.ctWithTag.subarray(parsed.ctWithTag.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', args.dek, parsed.iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(buildAad({ ...args.aad, epoch: parsed.epoch }));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    throw new AeadError('AEAD decryption failed (tampered ciphertext, wrong key, or AAD mismatch)', err);
  }
}
