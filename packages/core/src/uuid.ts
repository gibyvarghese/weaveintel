/**
 * @weaveintel/core/uuid
 *
 * UUID v7 — time-ordered UUID generator.
 *
 * UUID v7 layout (128 bits):
 *   [0..47]   unix_ts_ms  — 48-bit millisecond timestamp
 *   [48..51]  ver         — 0x7 (version 7)
 *   [52..63]  rand_a      — 12 random bits
 *   [64..65]  var         — 0b10 (RFC 4122 variant)
 *   [66..127] rand_b      — 62 random bits
 *
 * Format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 *   where y is 8, 9, a, or b.
 *
 * Time-ordering: rows with higher timestamps sort lexicographically later,
 * making UUID v7 safe as a SQLite TEXT primary key with ORDER BY id.
 *
 * Zero npm dependencies — uses node:crypto for randomness.
 */

import { randomBytes } from 'node:crypto';

/**
 * Generate a new UUID v7 string.
 *
 * @returns A UUID v7 string in canonical lowercase hyphenated form.
 */
export function newUUIDv7(): string {
  const now = BigInt(Date.now());

  // 10 random bytes for the non-timestamp parts
  const rand = randomBytes(10);

  // Bits [0..47]: timestamp (ms)
  const tsHigh = Number((now >> 16n) & 0xffffffffn); // top 32 bits of timestamp >> 16
  const tsMid = Number(now & 0xffffn);                // bottom 16 bits of timestamp

  // Bits [48..51]: version = 7; [52..63]: rand_a (12 bits from rand[0..1])
  const randA = ((rand[0]! & 0x0f) << 8) | rand[1]!;  // 12 bits
  const ver7 = 0x7000 | randA;

  // Bits [64..65]: variant = 0b10; [66..127]: rand_b (62 bits from rand[2..9])
  const variantByte = 0x80 | (rand[2]! & 0x3f);       // sets top 2 bits to 10
  const randB1 = rand[3]!;

  const hex2 = (n: number) => n.toString(16).padStart(2, '0');
  const hex4 = (n: number) => n.toString(16).padStart(4, '0');
  const hex8 = (n: number) => n.toString(16).padStart(8, '0');

  // Last 12 hex chars: 6 raw random bytes (rand[4..9]) — emit byte-wise to avoid
  // 32-bit JavaScript bitshift truncation.
  const tail = hex2(rand[4]!) + hex2(rand[5]!) + hex2(rand[6]!) + hex2(rand[7]!) + hex2(rand[8]!) + hex2(rand[9]!);

  return [
    hex8(tsHigh),                          // 8 hex chars — top 32 bits of ts
    hex4(tsMid),                           // 4 hex chars — bottom 16 bits of ts
    hex4(ver7),                            // 4 hex chars — version + rand_a
    hex4((variantByte << 8) | randB1),     // 4 hex chars — variant + rand_b[0..7]
    tail,                                  // 12 hex chars — rand_b[8..63]
  ].join('-');
}
