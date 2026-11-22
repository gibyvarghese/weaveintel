/**
 * The closed list of transforms a mapping row may name (FRAMEWORK 4.6). Each is a plain function of the value and
 * one plain argument. There are no expressions, scripts or templates: anything these cannot do is a new transform,
 * released and tested here.
 */

/** The transforms. */
export const TRANSFORMS = ['none', 'trim', 'lowercase', 'uppercase', 'number', 'boolean', 'date', 'epoch_to_datetime', 'default_if_empty', 'join_lines', 'split_lines', 'minor_units_to_decimal', 'choice_map'] as const
/** One transform. */
export type Transform = (typeof TRANSFORMS)[number]

/** Choice maps by key: outside value → platform value. */
export type ChoiceMaps = Readonly<Record<string, Readonly<Record<string, string>>>>

const empty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/**
 * Apply one transform.
 * @param name The transform.
 * @param value The value read from the source.
 * @param arg The row's plain argument (a choice map key, a number of decimal places, a default).
 * @param maps The choice maps in force.
 * @returns the transformed value; undefined when the value cannot be read as the transform expects.
 * @throws Error for a name that is not on the list.
 */
export function applyTransform(name: Transform, value: unknown, arg: string, maps: ChoiceMaps): unknown {
  switch (name) {
    case 'none': return value
    case 'trim': return typeof value === 'string' ? value.trim() : value
    case 'lowercase': return typeof value === 'string' ? value.toLowerCase() : value
    case 'uppercase': return typeof value === 'string' ? value.toUpperCase() : value
    case 'number': {
      if (empty(value)) return undefined
      const n = typeof value === 'number' ? value : Number(String(value).trim())
      return Number.isFinite(n) ? n : undefined
    }
    case 'boolean': {
      const s = String(value).trim().toLowerCase()
      if (value === true || ['true', 'yes', '1', 'on'].includes(s)) return true
      if (value === false || ['false', 'no', '0', 'off'].includes(s)) return false
      return undefined
    }
    case 'date': {
      if (empty(value)) return undefined
      const d = new Date(String(value))
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
    }
    case 'epoch_to_datetime': {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return undefined
      return new Date(n > 1e12 ? n : n * 1000).toISOString()
    }
    case 'default_if_empty': return empty(value) ? arg : value
    case 'join_lines': return Array.isArray(value) ? value.map((v) => String(v)).join('\n') : value
    case 'split_lines': return typeof value === 'string' ? value.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '') : value
    case 'minor_units_to_decimal': {
      const n = typeof value === 'number' ? value : Number(value)
      const places = arg === '' ? 2 : Number(arg)
      if (!Number.isFinite(n) || !Number.isInteger(places) || places < 0 || places > 8) return undefined
      return Number((n / 10 ** places).toFixed(places))
    }
    case 'choice_map': {
      if (empty(value)) return undefined
      return maps[arg]?.[String(value)]
    }
    default: throw new Error(`unknown transform "${String(name)}"`)
  }
}
