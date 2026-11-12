// SPDX-License-Identifier: MIT
/**
 * @weaveintel/core — strict address classification for outbound fetches of
 * URLs a PERSON supplied (a pasted link, a file to fetch).
 *
 * Stricter than `net-guard.ts` (which allows loopback by default, for
 * provider SDK tests): here only public unicast addresses pass. Blocked:
 * loopback, RFC 1918, link-local (incl. 169.254.169.254 metadata), CGNAT
 * 100.64/10, 0.0.0.0/8, benchmarking 198.18/15, documentation ranges,
 * multicast and reserved space, IPv6 loopback / unspecified / ULA / link-local /
 * site-local / multicast / documentation, IPv4-mapped, IPv4-compatible and
 * NAT64 (64:ff9b::/96) forms of any blocked IPv4, 6to4 and Teredo.
 *
 * Use with a connect-time DNS lookup hook so the address checked is the
 * address connected to (no DNS-rebinding window).
 */

import { isIP } from 'node:net';

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'cgnat'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'invalid';

function v4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n >>> 0;
}

const inV4 = (n: number, base: string, bits: number): boolean => {
  const b = v4ToInt(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) >>> 0 === (b & mask) >>> 0;
};

export function classifyIPv4(ip: string): AddressClass {
  const n = v4ToInt(ip);
  if (n === undefined) return 'invalid';
  if (inV4(n, '0.0.0.0', 8)) return 'unspecified';
  if (inV4(n, '127.0.0.0', 8)) return 'loopback';
  if (inV4(n, '10.0.0.0', 8) || inV4(n, '172.16.0.0', 12) || inV4(n, '192.168.0.0', 16)) return 'private';
  if (inV4(n, '169.254.0.0', 16)) return 'link_local';
  if (inV4(n, '100.64.0.0', 10)) return 'cgnat';
  if (inV4(n, '192.0.2.0', 24) || inV4(n, '198.51.100.0', 24) || inV4(n, '203.0.113.0', 24)) return 'documentation';
  if (inV4(n, '224.0.0.0', 4)) return 'multicast';
  if (inV4(n, '192.0.0.0', 24) || inV4(n, '198.18.0.0', 15) || inV4(n, '240.0.0.0', 4) || inV4(n, '192.88.99.0', 24)) return 'reserved';
  return 'public';
}

/** Expand an IPv6 literal to 8 hextets (handles `::` and a trailing dotted quad). */
function expandV6(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    if (n === undefined) return undefined;
    s = s.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (missing < 0) return undefined;
  const all = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out = all.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return out.some((x) => Number.isNaN(x)) ? undefined : out;
}

const v4FromHextets = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

export function classifyIPv6(ip: string): AddressClass {
  const h = expandV6(ip);
  if (!h) return 'invalid';
  const zeroPrefix = (k: number): boolean => h.slice(0, k).every((x) => x === 0);
  if (h.every((x) => x === 0)) return 'unspecified';
  if (zeroPrefix(7) && h[7] === 1) return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d: judge the IPv4.
  if (zeroPrefix(5) && h[5] === 0xffff) return classifyIPv4(v4FromHextets(h[6]!, h[7]!));
  if (zeroPrefix(6)) return classifyIPv4(v4FromHextets(h[6]!, h[7]!));
  // NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48.
  if (h[0] === 0x64 && h[1] === 0xff9b) return h[2] === 1 ? 'reserved' : classifyIPv4(v4FromHextets(h[6]!, h[7]!));
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return 'private'; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return 'link_local';
  if ((first & 0xffc0) === 0xfec0) return 'private'; // site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return 'multicast';
  if (first === 0x2001 && h[1] === 0x0db8) return 'documentation';
  if (first === 0x2002) return 'reserved'; // 6to4 can tunnel to any IPv4
  if (first === 0x2001 && h[1] === 0) return 'reserved'; // Teredo
  if (first === 0x0100 && zeroPrefix(4)) return 'reserved'; // discard-only
  return 'public';
}

/** Classify an IP literal (v4 or v6). Anything that is not an IP literal is `invalid`. */
export function classifyAddress(ip: string): AddressClass {
  const bare = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(bare);
  if (kind === 4) return classifyIPv4(bare);
  if (kind === 6) return classifyIPv6(bare);
  return 'invalid';
}

export function isPublicAddress(ip: string): boolean {
  return classifyAddress(ip) === 'public';
}
