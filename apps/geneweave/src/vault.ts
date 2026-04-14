/**
 * @weaveintel/geneweave — Credential vault (AES-256-GCM encryption)
 *
 * Encrypts / decrypts website credentials at rest.  Each row uses a
 * unique random IV.  The master key is derived from the VAULT_KEY
 * environment variable (or falls back to JWT_SECRET for dev).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SALT = 'weaveintel-vault-v1';   // fixed salt (key uniqueness via env var)

let _derived: Buffer | null = null;

function deriveKey(): Buffer {
  if (_derived) return _derived;
  const master = process.env['VAULT_KEY'] ?? process.env['JWT_SECRET'];
  if (!master) throw new Error('VAULT_KEY (or JWT_SECRET) must be set for credential encryption');
  _derived = scryptSync(master, SALT, KEY_LEN);
  return _derived;
}

/**
 * Encrypt a JSON-serialisable object → base64 string.
 * Format: base64( IV || ciphertext || authTag )
 */
export function encryptCredential(plainObj: unknown): { encrypted: string; iv: string } {
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const json = JSON.stringify(plainObj);
  const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, enc, tag]);
  return {
    encrypted: payload.toString('base64'),
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypt base64 string → parsed JSON object.
 */
export function decryptCredential<T = unknown>(encrypted: string): T {
  const key = deriveKey();
  const buf = Buffer.from(encrypted, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(dec.toString('utf8')) as T;
}
