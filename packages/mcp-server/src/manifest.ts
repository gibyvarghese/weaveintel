// SPDX-License-Identifier: MIT
/**
 * Manifest hashing.
 *
 * A client agrees to a server's tools as it saw them: their names, descriptions, schemas and
 * annotations. If any of that changes later (a description quietly grows an instruction, a schema
 * widens), the client should know before it calls again. `manifestHash` is a stable fingerprint of a
 * tool list: the same tools give the same hash whatever their order or key order, and any change to
 * what a model reads gives a different one. The endpoint publishes it in `tools/list` `_meta` and, when
 * a call carries the hash its client saw, refuses the call if the list has changed since.
 *
 * `parameterHash` is the same idea for one call: a fingerprint of the tool name and its arguments, so a
 * confirmation given for one set of arguments can be bound to exactly those arguments.
 */
import { createHash } from 'node:crypto';
import type { McpTool } from './jsonrpc.js';

/** The `_meta` key the manifest hash is published (and echoed by a client) under. */
export const MCP_MANIFEST_META_KEY = 'io.weaveintel/manifest';

/**
 * JSON with object keys sorted at every depth, so equal values always give equal text. Arrays keep
 * their order (order is meaning there, e.g. `required`). Values JSON cannot carry faithfully
 * (non-finite numbers, bigints, functions, symbols) are refused rather than silently dropped.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value, '$'));
}

function normalise(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`canonicalJson: ${path} is not a finite number`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((v, i) => (v === undefined ? null : normalise(v, `${path}[${i}]`)));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = normalise(v, `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(`canonicalJson: ${path} is a ${typeof value}, which JSON cannot carry`);
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * The fingerprint of a tool list as a client sees it. Covers every field of each tool except `_meta`
 * (which carries transport hints and this hash itself). Tool order does not matter; two tools with one
 * name are refused.
 */
export function manifestHash(tools: readonly McpTool[]): string {
  const seen = new Set<string>();
  const entries = tools.map((tool) => {
    if (seen.has(tool.name)) throw new Error(`manifestHash: duplicate tool name "${tool.name}"`);
    seen.add(tool.name);
    const { _meta: _ignored, ...rest } = tool;
    return rest;
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256(canonicalJson(entries));
}

/** The fingerprint of one call: the tool name and its arguments, key order aside. */
export function parameterHash(toolName: string, args: Readonly<Record<string, unknown>>): string {
  return sha256(canonicalJson({ tool: toolName, arguments: args }));
}
