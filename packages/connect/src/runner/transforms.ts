/**
 * The closed list of transforms a mapping row may name (FRAMEWORK 4.6). Each is a plain function of the value and
 * one plain argument. There are no expressions, scripts or templates: anything these cannot do is a new transform,
 * released and tested here AND in schemaWeave inbound.
 *
 * ONE VOCABULARY, TWO LIBRARIES, ONE CONTRACT
 * The same names with the same behaviour are the mapping vocabulary of schemaWeave `@schemaweave/inbound`
 * (`MAPPING_TRANSFORMS`, `applyMappingTransform`), which is the one engine for inbound data, and of weaveIntel
 * `@weaveintel/extraction` (which proposes mappings and converts its proposals to these names). The golden file
 * `transform-vectors.json` (carried byte for byte in both libraries) fixes the behaviour; both test suites run it.
 *
 * The argument, per transform:
 *  - `date`: the date order (`iso`, `day_first`, `month_first`, `ambiguous`; empty means `ambiguous`).
 *  - `number`: the number style (`plain`, `dot_decimal`, `comma_decimal`, `ambiguous`; empty means `ambiguous`).
 *  - `default_if_empty`: the default value.
 *  - `minor_units_to_decimal`: decimal places (empty means 2).
 *  - `choice_map`: which choice map (the runner looks it up by key in the maps in force).
 *
 * A value that cannot be read as the transform expects becomes `undefined` (refused), never a guess. A `choice_map`
 * miss passes the (trimmed) value through, so the target field's own check refuses it visibly.
 */
import { DATE_ORDERS, NUMBER_STYLES, dateText, readBoolean, readDate, readNumber, type DateOrder, type NumberStyle } from './readers.js'

/** The transforms (contract version {@link TRANSFORM_CONTRACT_VERSION}). */
export const TRANSFORMS = ['none', 'trim', 'lowercase', 'uppercase', 'number', 'boolean', 'date', 'epoch_to_datetime', 'default_if_empty', 'join_lines', 'split_lines', 'minor_units_to_decimal', 'choice_map'] as const
/** One transform. */
export type Transform = (typeof TRANSFORMS)[number]
/** The version of the shared transform contract this list and its behaviour implement. */
export const TRANSFORM_CONTRACT_VERSION = 1

/** Whether a value names a transform on the list. */
export function isTransform(v: unknown): v is Transform {
  return typeof v === 'string' && (TRANSFORMS as readonly string[]).includes(v)
}

/** Choice maps by key: outside value → platform value. */
export type ChoiceMaps = Readonly<Record<string, Readonly<Record<string, string>>>>

const empty = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)

function orderOf(arg: string): DateOrder {
  if (arg === '') return 'ambiguous'
  if (!(DATE_ORDERS as readonly string[]).includes(arg)) throw new Error(`"${arg}" is not a date order (iso, day_first, month_first, ambiguous).`)
  return arg as DateOrder
}

function styleOf(arg: string): NumberStyle {
  if (arg === '') return 'ambiguous'
  if (!(NUMBER_STYLES as readonly string[]).includes(arg)) throw new Error(`"${arg}" is not a number style (plain, dot_decimal, comma_decimal, ambiguous).`)
  return arg as NumberStyle
}

/**
 * Apply one transform to one choice map, with no lookup by key: the form both libraries share.
 * @param name The transform.
 * @param value The value read from the source.
 * @param arg The row's plain argument.
 * @param choiceMap The choice map for `choice_map` (ignored by the others).
 * @returns the transformed value; undefined when the value cannot be read as the transform expects.
 * @throws Error for a name that is not on the list, or an argument outside its closed list.
 */
export function applyMappingTransform(name: Transform, value: unknown, arg = '', choiceMap?: Readonly<Record<string, string>>): unknown {
  switch (name) {
    case 'none': return value
    case 'trim': return typeof value === 'string' ? value.trim() : value
    case 'lowercase': return typeof value === 'string' ? value.toLowerCase() : value
    case 'uppercase': return typeof value === 'string' ? value.toUpperCase() : value
    case 'number': {
      const style = styleOf(arg)
      if (empty(value) || (typeof value !== 'string' && typeof value !== 'number')) return undefined
      return readNumber(value, style)
    }
    case 'boolean': {
      if (empty(value) || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) return undefined
      return readBoolean(value)
    }
    case 'date': {
      const order = orderOf(arg)
      if (empty(value) || (typeof value !== 'string' && typeof value !== 'number')) return undefined
      const read = readDate(value, order)
      return read === undefined ? undefined : dateText(read)
    }
    case 'epoch_to_datetime': {
      if (empty(value)) return undefined
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return undefined
      const d = new Date(n > 1e12 ? n : n * 1000)
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
    }
    case 'default_if_empty': return empty(value) ? arg : value
    case 'join_lines': return Array.isArray(value) ? value.map((v) => String(v)).join('\n') : value
    case 'split_lines': return typeof value === 'string' ? value.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '') : value
    case 'minor_units_to_decimal': {
      if (empty(value)) return undefined
      const n = typeof value === 'number' ? value : Number(value)
      const places = arg === '' ? 2 : Number(arg)
      if (!Number.isFinite(n) || !Number.isInteger(places) || places < 0 || places > 8) return undefined
      return Number((n / 10 ** places).toFixed(places))
    }
    case 'choice_map': {
      if (empty(value)) return undefined
      const key = typeof value === 'string' ? value.trim() : String(value)
      return choiceMap !== undefined && Object.prototype.hasOwnProperty.call(choiceMap, key) ? choiceMap[key] : key
    }
    default: throw new Error(`unknown transform "${String(name)}"`)
  }
}

/**
 * Apply one transform, looking a `choice_map` up by its key in the maps in force (the runner's rows name the map).
 * @param name The transform.
 * @param value The value read from the source.
 * @param arg The row's plain argument (for `choice_map`, the map's key).
 * @param maps The choice maps in force.
 * @throws Error for a name that is not on the list, or an argument outside its closed list.
 */
export function applyTransform(name: Transform, value: unknown, arg: string, maps: ChoiceMaps): unknown {
  return applyMappingTransform(name, value, arg, name === 'choice_map' ? (maps[arg] ?? {}) : undefined)
}
