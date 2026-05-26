#!/usr/bin/env node
// Shared utilities for scripts/e2e-phase*.mjs test scripts.
import assert from 'node:assert/strict';

export const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
export const DB_PATH = process.env.DATABASE_PATH ?? './geneweave.db';

/**
 * Returns an assertion helper that tracks pass count.
 * Usage: const ok = makeOk();  ...  console.log(`${ok.count()} assertions`);
 */
export function makeOk() {
  let n = 0;
  function ok(cond, msg) {
    n++;
    assert(cond, msg);
    console.log(`  ✓ ${msg}`);
  }
  ok.count = () => n;
  return ok;
}

export async function jfetch(method, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.csrf ? { 'x-csrf-token': opts.csrf } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
