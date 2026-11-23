/**
 * The same mapping rows the operation runner reads, aimed at a JSON-RPC payload instead of an HTTP request: `out` rows
 * write into `arguments.x` (MCP) or `data.x` / `text` (A2A message parts); `in` rows read from the result. Transforms
 * (contract v1) and encodings behave exactly as for operations, and only declared outputs are kept.
 */
import type { ConnectRefusal, Json } from '../types.js'
import { refusal } from '../types.js'
import { decodeValue, encodeValue } from '../runner/encodings.js'
import { getAt, setAt } from '../runner/paths.js'
import type { DeclaredOutput, RequestMapping, ResponseMapping } from '../runner/spec.js'
import { applyTransform, type ChoiceMaps } from '../runner/transforms.js'

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
const words = (name: string): string => name.replace(/[_.]/g, ' ').trim()

/**
 * Fill an object from `out` rows whose target starts with `<root>:` (for example `arguments:query`).
 * @param root The only target prefix accepted; any other target is a pack error.
 */
export function mapIntoArguments(rows: readonly RequestMapping[], input: Readonly<Record<string, unknown>>, settings: Readonly<Record<string, string>>, maps: ChoiceMaps, root: string): { readonly ok: true; readonly value: Record<string, unknown> } | ConnectRefusal {
  const value: Record<string, unknown> = {}
  for (const row of rows) {
    const [part, ...rest] = row.target.split(':')
    const where = rest.join(':')
    if (part !== root || where === '') return refusal('BAD_OPERATION', `A mapping writes to “${row.target}”; here only “${root}:…” is a place.`)
    const raw = row.from === 'input' ? getAt(input, row.source) : row.from === 'setting' ? settings[row.source] : row.source
    let v = row.transform === undefined || row.transform === 'none' ? raw : applyTransform(row.transform, raw, row.transformArg ?? '', maps)
    if (isEmpty(v) && row.defaultValue !== undefined && row.defaultValue !== '') v = row.defaultValue
    v = encodeValue(row.encoding, v)
    if (isEmpty(v)) {
      if (row.required === true) return refusal('BAD_INPUT', `The ${words(row.source)} is needed.`)
      continue
    }
    try { setAt(value, where, v) } catch { return refusal('BAD_OPERATION', `A mapping writes to “${row.target}”, which can’t be written.`) }
  }
  return { ok: true, value }
}

const asJson = (v: unknown): Json | undefined => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Json))

/** Read declared outputs from a result with `in` rows (list rows use `itemOf` and the list's own path in `source` of the list row). */
export function mapOutputs(rows: readonly ResponseMapping[], outputs: readonly DeclaredOutput[], from: unknown, maps: ChoiceMaps): Record<string, Json> {
  const declared = new Set(outputs.map((o) => o.name))
  const out: Record<string, Json> = {}
  const read = (row: ResponseMapping, at: unknown): unknown => {
    const decoded = decodeValue(row.encoding, getAt(at, row.source))
    let v = row.transform === undefined || row.transform === 'none' ? decoded : applyTransform(row.transform, decoded, row.transformArg ?? '', maps)
    if ((v === undefined || v === null || v === '') && row.defaultValue !== undefined && row.defaultValue !== '') v = row.defaultValue
    return v
  }
  for (const row of rows) {
    if (row.itemOf !== undefined && row.itemOf !== '') continue
    if (!declared.has(row.target)) continue
    const v = read(row, from)
    // A row naming a declared list output with item rows is the list's path.
    const itemRows = rows.filter((x) => x.itemOf === row.target)
    if (itemRows.length > 0 && Array.isArray(v)) {
      out[row.target] = v.map((item) => {
        const o: Record<string, unknown> = {}
        for (const ir of itemRows) { const x = read(ir, item); if (x !== undefined) setAt(o, ir.target, x) }
        return asJson(o) as Json
      })
      continue
    }
    const j = asJson(v)
    if (j !== undefined) out[row.target] = j
  }
  return out
}
