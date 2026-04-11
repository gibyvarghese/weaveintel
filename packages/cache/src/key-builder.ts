/**
 * @weaveintel/cache — Cache key builder
 *
 * Deterministic, collision-resistant cache key generation from
 * structured parts. Supports namespacing and scope isolation.
 */

import type { CacheKeyBuilder } from '@weaveintel/core';

/**
 * Creates a CacheKeyBuilder that generates deterministic keys
 * from key-value parts using sorted, delimited concatenation.
 */
export function weaveCacheKeyBuilder(opts?: {
  namespace?: string;
  separator?: string;
}): CacheKeyBuilder {
  const ns = opts?.namespace ?? 'wc';
  const sep = opts?.separator ?? ':';

  return {
    build(parts: Record<string, string | number | boolean>): string {
      const sortedKeys = Object.keys(parts).sort();
      const segments = sortedKeys.map((k) => `${k}=${String(parts[k])}`);
      return ns + sep + segments.join(sep);
    },

    parse(key: string): Record<string, string> {
      const result: Record<string, string> = {};
      const withoutNs = key.startsWith(ns + sep) ? key.slice(ns.length + sep.length) : key;
      const segments = withoutNs.split(sep);
      for (const seg of segments) {
        const eqIdx = seg.indexOf('=');
        if (eqIdx > 0) {
          result[seg.slice(0, eqIdx)] = seg.slice(eqIdx + 1);
        }
      }
      return result;
    },
  };
}
