// SPDX-License-Identifier: MIT
/**
 * Result-cache keys. A finished result is reused only when EVERYTHING that
 * produced it is the same: the tenant, the exact bytes, the pipeline version,
 * the field schema version and the model version. The tenant comes first and
 * is required, so one tenant's results can never answer another's (which
 * would also leak, through timing, that the other tenant has the same file).
 */

import { createHash } from 'node:crypto';
import { WeaveIntelError } from '@weaveintel/core';
import type { ResultCache } from './ports.js';

export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface CacheKeyParts {
  readonly tenantId: string;
  readonly contentHash: string;
  readonly pipelineVersion: string;
  /** Version of the field definitions / document-type config. */
  readonly schemaVersion?: string;
  /** Engine and model identities (e.g. "model-extractor:claude-sonnet-4-6@2026-10"). */
  readonly modelVersion?: string;
  /** Anything else that changes the output (options, labels). */
  readonly extra?: Readonly<Record<string, string>>;
}

export function resultCacheKey(parts: CacheKeyParts): string {
  if (!parts.tenantId || /[:\s]/.test(parts.tenantId)) {
    throw new WeaveIntelError({ code: 'INVALID_INPUT', message: 'A result-cache key needs a tenant id without spaces or colons.' });
  }
  if (!/^[0-9a-f]{64}$/.test(parts.contentHash)) {
    throw new WeaveIntelError({ code: 'INVALID_INPUT', message: 'A result-cache key needs a SHA-256 content hash.' });
  }
  const extra = Object.keys(parts.extra ?? {}).sort().map((k) => [k, parts.extra![k]]);
  const digest = createHash('sha256')
    .update(JSON.stringify([parts.contentHash, parts.pipelineVersion, parts.schemaVersion ?? '', parts.modelVersion ?? '', extra]))
    .digest('hex');
  return `${parts.tenantId}:fu:${digest}`;
}

/** An in-memory cache, for tests and single-process hosts. Hosts persist results in their own tenant-scoped store. */
export function createMemoryResultCache<T = unknown>(opts?: { maxEntries?: number }): ResultCache<T> & { readonly size: number } {
  const max = opts?.maxEntries ?? 1000;
  const map = new Map<string, T>();
  return {
    get size() {
      return map.size;
    },
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      if (map.size >= max && !map.has(key)) map.delete(map.keys().next().value as string);
      map.set(key, value);
    },
  };
}
