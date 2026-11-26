// F-L2: the package's public shape. Every subpath in the exports map has a source entry, and the shared types
// carry the words every other part of the framework uses.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OUTCOMES, isOutcome, outcomeForStatus, type Send, type WireRequest } from './index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('@weaveintel/connect skeleton', () => {
  it('has a source entry for every subpath it exports', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, { import: string }> }
    const subpaths = Object.keys(pkg.exports)
    expect(subpaths).toEqual(['.', './credentials', './runner', './forms', './inbound', './replay', './sources', './remote'])
    for (const s of subpaths) {
      const src = pkg.exports[s]!.import.replace('./dist/', './src/').replace(/\.js$/, '.ts')
      expect(existsSync(join(root, src)), `${s} -> ${src}`).toBe(true)
    }
  })

  it('names a closed list of outcomes and maps answer codes onto it', () => {
    expect(OUTCOMES).toEqual(['ok', 'not_found', 'conflict', 'invalid', 'forbidden', 'throttled', 'unavailable', 'unknown', 'refused'])
    expect(isOutcome('ok')).toBe(true)
    expect(isOutcome('maybe')).toBe(false)
    expect([200, 204, 404, 409, 400, 422, 401, 403, 429, 500, 503, 302].map((s) => outcomeForStatus(s))).toEqual(['ok', 'ok', 'not_found', 'conflict', 'invalid', 'invalid', 'forbidden', 'forbidden', 'throttled', 'unavailable', 'unavailable', 'invalid'])
  })

  it('types the one way out as a function the caller supplies', async () => {
    const seen: WireRequest[] = []
    const send: Send = async (r) => { seen.push(r); return { ok: true, status: 200, headers: {}, body: '{}' } }
    const r = await send({ method: 'GET', url: 'https://example.test/', headers: {} })
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(1)
  })
})
