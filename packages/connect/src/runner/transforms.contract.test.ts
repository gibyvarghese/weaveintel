// The shared transform contract (FRAMEWORK 4.6): one closed list, same names, same behaviour, in weaveIntel connect
// and in schemaWeave inbound. `transform-vectors.json` is carried byte for byte in both libraries; the fingerprint
// below is the same constant in both test suites, so a vector edited on one side only fails here or there.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TRANSFORMS, TRANSFORM_CONTRACT_VERSION, applyMappingTransform, applyTransform, isTransform, type Transform } from './transforms.js'

/** sha256 of transform-vectors.json, identical in schemaWeave `packages/inbound/src/transforms.contract.test.ts`. */
const VECTORS_SHA256 = '623db616d38f7702ea3f8fc25f2ca1ecd4f65fd7ba0c02acbfadaa2389d77b3a'

const raw = readFileSync(join(import.meta.dirname, 'transform-vectors.json'), 'utf8')
interface Vector { readonly t: string; readonly arg?: string; readonly map?: Record<string, string>; readonly in: unknown; readonly out: unknown }
const file = JSON.parse(raw) as { version: number; transforms: string[]; vectors: Vector[]; bad_args: { t: string; arg: string }[] }
const expected = (v: unknown): unknown => (v !== null && typeof v === 'object' && (v as Record<string, unknown>)['$undefined'] === true ? undefined : v)

describe('the shared mapping-transform contract', () => {
  it('is the same file as schemaWeave carries', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256)
  })
  it('names exactly the closed list, at the contract version', () => {
    expect([...TRANSFORMS]).toEqual(file.transforms)
    expect(TRANSFORM_CONTRACT_VERSION).toBe(file.version)
    expect(isTransform('eval')).toBe(false)
  })
  it('covers every transform with at least one vector', () => {
    for (const t of TRANSFORMS) expect(file.vectors.some((v) => v.t === t), t).toBe(true)
  })
  it.each(file.vectors.map((v, i) => [i, v] as const))('vector %i', (_i, v) => {
    expect(applyMappingTransform(v.t as Transform, v.in, v.arg ?? '', v.map)).toEqual(expected(v.out))
    // The runner's form (a choice map named by key) answers the same.
    const viaRunner = v.t === 'choice_map' ? applyTransform('choice_map', v.in, 'm', { m: v.map ?? {} }) : applyTransform(v.t as Transform, v.in, v.arg ?? '', {})
    expect(viaRunner).toEqual(expected(v.out))
  })
  it.each(file.bad_args.map((b) => [b.t, b.arg] as const))('refuses %s with an argument outside its list (%s)', (t, arg) => {
    expect(() => applyMappingTransform(t as Transform, 'x', arg)).toThrow()
  })
})
