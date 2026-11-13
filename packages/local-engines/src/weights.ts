// SPDX-License-Identifier: MIT
/**
 * Pinned-file checks. A step that loads model files lists each file's size and SHA-256 in the ticket; an engine checks
 * the bytes it fetched before it loads them. The check runs on the device by necessity, so the server records the hash
 * a device reports but never trusts it.
 */

import { sha256Hex } from './canonical.js';
import type { TicketFile } from './ticket.js';

export type FileCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'size_mismatch' | 'hash_mismatch';
      readonly name: string;
    };

/** Compare bytes against a pinned file: size first, then SHA-256. */
export async function verifyFileBytes(
  file: TicketFile,
  bytes: ArrayBuffer | ArrayBufferView,
): Promise<FileCheck> {
  const length = bytes.byteLength;
  if (length !== file.bytes) return { ok: false, reason: 'size_mismatch', name: file.name };
  const actual = await sha256Hex(bytes);
  if (actual !== file.sha256.toLowerCase())
    return { ok: false, reason: 'hash_mismatch', name: file.name };
  return { ok: true };
}
