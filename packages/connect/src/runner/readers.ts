/**
 * The value readers behind the `date`, `number` and `boolean` transforms.
 *
 * WHY THIS FILE MIRRORS ANOTHER LIBRARY
 * The mapping vocabulary is ONE closed list with one behaviour (FRAMEWORK 4.6). Its reference engine is schemaWeave
 * `@schemaweave/inbound` (`temporal.ts`, `numeric.ts`), which owns inbound data. schemaWeave may not import
 * weaveIntel, and this package keeps no runtime dependencies, so the runner carries the same readers. They are held
 * to the same behaviour by one golden file, `transform-vectors.json`, carried byte for byte in both libraries and
 * checked by both test suites (see `transforms.contract.test.ts`). Change a reader here only together with the
 * vectors and with schemaWeave.
 *
 * THE RULE THAT MATTERS: refuse rather than guess. `03/04/2026` with no agreed order, or `1.234` with no agreed number
 * style, is not read (undefined), because both readings are plausible and a silently wrong value is never caught later.
 */

/** How the numbers in a slash, dot or dash date are ordered. `ambiguous` refuses every all-numeric date. */
export type DateOrder = 'iso' | 'day_first' | 'month_first' | 'ambiguous'
/** The date orders, in the order they are offered. */
export const DATE_ORDERS: readonly DateOrder[] = ['iso', 'day_first', 'month_first', 'ambiguous']

/** How a value separates thousands from decimals. `ambiguous` reads only the values that settle themselves. */
export type NumberStyle = 'plain' | 'dot_decimal' | 'comma_decimal' | 'ambiguous'
/** The number styles. */
export const NUMBER_STYLES: readonly NumberStyle[] = ['plain', 'dot_decimal', 'comma_decimal', 'ambiguous']

/** A date that was understood. */
export interface ReadDate {
  /** `YYYY-MM-DD`. */
  readonly date: string
  /** `HH:MM:SS`, when the value carried a time. */
  readonly time?: string | undefined
  /** The zone as written (`Z`, `+05:30`), when the value carried one. */
  readonly zone?: string | undefined
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/
const NUMERIC = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/
const NAMED = /^(?:(\d{1,2})\s+([A-Za-z]{3,9})|([A-Za-z]{3,9})\s+(\d{1,2}))[,\s]+(\d{4})$/
const SERIAL = /^\d{1,6}(\.\d+)?$/
const MONTHS: Readonly<Record<string, number>> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1) return false
  const lengths = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= lengths[month - 1]!
}

/** A spreadsheet's day count (1900 system, with its phantom 29 February 1900) as a date. */
export function fromSpreadsheetSerial(serial: number): ReadDate | undefined {
  if (!Number.isFinite(serial) || serial < 1) return undefined
  const whole = Math.floor(serial)
  if (whole === 60) return undefined
  const days = whole > 60 ? whole - 1 : whole
  const at = new Date(Date.UTC(1899, 11, 31) + days * 86_400_000)
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() > 9999) return undefined
  const date = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
  const fraction = serial - whole
  if (fraction === 0) return { date }
  const seconds = Math.round(fraction * 86_400)
  return { date, time: `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}` }
}

/** Read one value as a date, using an agreed order. A number is a spreadsheet serial. */
export function readDate(value: string | number, order: DateOrder): ReadDate | undefined {
  if (typeof value === 'number') return fromSpreadsheetSerial(value)
  const text = value.trim()
  if (text === '') return undefined
  const iso = ISO.exec(text)
  if (iso !== null) {
    const [, y, mo, d, hh, mm, ss, zone] = iso
    if (!isRealDate(Number(y), Number(mo), Number(d))) return undefined
    return { date: `${y!}-${mo!}-${d!}`, ...(hh === undefined ? {} : { time: `${hh}:${mm!}:${ss ?? '00'}` }), ...(zone === undefined ? {} : { zone }) }
  }
  const named = NAMED.exec(text)
  if (named !== null) {
    const day = Number(named[1] ?? named[4])
    const month = MONTHS[(named[2] ?? named[3] ?? '').slice(0, 3).toLowerCase()]
    const year = Number(named[5])
    if (month === undefined || !isRealDate(year, month, day)) return undefined
    return { date: `${pad(year, 4)}-${pad(month)}-${pad(day)}` }
  }
  const numeric = NUMERIC.exec(text)
  if (numeric !== null) {
    const [, one, two, three, hh, mm, ss, meridiem] = numeric
    let year: number
    let month: number
    let day: number
    if (one!.length === 4) {
      year = Number(one); month = Number(two); day = Number(three)
    } else {
      if (order === 'ambiguous') return undefined
      day = order === 'day_first' ? Number(one) : Number(two)
      month = order === 'day_first' ? Number(two) : Number(one)
      year = Number(three)
      if (three!.length <= 2) year += year <= 68 ? 2000 : 1900
    }
    if (!isRealDate(year, month, day)) return undefined
    let hour = hh === undefined ? undefined : Number(hh)
    if (hour !== undefined && meridiem !== undefined) {
      const pm = meridiem.toLowerCase() === 'pm'
      hour = pm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour
    }
    if (hour !== undefined && hour > 23) return undefined
    return { date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`, ...(hour === undefined ? {} : { time: `${pad(hour)}:${mm!}:${ss ?? '00'}` }) }
  }
  if (SERIAL.test(text)) return fromSpreadsheetSerial(Number(text))
  return undefined
}

/** A read date as text: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM:SS` plus its zone (`Z` when none was written). */
export function dateText(read: ReadDate): string {
  return read.time === undefined ? read.date : `${read.date}T${read.time}${read.zone ?? 'Z'}`
}

const CURRENCY = /^[\s]*(?:[$£€¥₹₽¢]|USD|EUR|GBP|NZD|AUD|CAD|JPY|INR)?[\s]*|[\s]*(?:[$£€¥₹₽¢]|USD|EUR|GBP|NZD|AUD|CAD|JPY|INR)?[\s]*$/g
const BARE = /^[+-]?[\d.,\s']*\d(?:[eE][+-]?\d+)?$/

function undress(raw: string): { body: string; negative: boolean } | undefined {
  let text = raw.trim()
  if (text === '') return undefined
  let negative = false
  if (text.startsWith('(') && text.endsWith(')')) { negative = true; text = text.slice(1, -1).trim() }
  if (text.endsWith('%')) text = text.slice(0, -1).trim()
  text = text.replace(CURRENCY, '').trim()
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1).trim() } else if (text.startsWith('+')) text = text.slice(1).trim()
  if (text === '' || !BARE.test(text)) return undefined
  return { body: text, negative }
}

function stripGrouping(body: string, decimal: '.' | ','): string {
  return body.replaceAll(decimal === '.' ? ',' : '.', '').replace(decimal, '.')
}

/** Read one value as a number, using an agreed style. Currency signs, percent signs and accounting brackets are read. */
export function readNumber(value: string | number, style: NumberStyle): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const parts = undress(value)
  if (parts === undefined) return undefined
  const body = parts.body.replace(/[\s']/g, '')
  const dots = (body.match(/\./g) ?? []).length
  const commas = (body.match(/,/g) ?? []).length
  let normalised: string
  if (dots === 0 && commas === 0) {
    normalised = body
  } else {
    const decimal = style === 'comma_decimal' ? ',' : style === 'dot_decimal' ? '.' : undefined
    if (decimal === undefined) {
      if (dots > 0 && commas > 0) {
        normalised = stripGrouping(body, body.lastIndexOf('.') > body.lastIndexOf(',') ? '.' : ',')
      } else {
        const sep = dots > 0 ? '.' : ','
        const count = dots > 0 ? dots : commas
        const tail = body.slice(body.lastIndexOf(sep) + 1)
        if (count > 1) normalised = body.replaceAll(sep, '')
        else if (tail.length !== 3) normalised = stripGrouping(body, sep)
        else return undefined
      }
    } else {
      normalised = stripGrouping(body, decimal)
    }
  }
  const n = Number(normalised)
  if (!Number.isFinite(n)) return undefined
  return parts.negative ? -n : n
}

const TRUE_WORDS: ReadonlySet<string> = new Set(['true', 't', 'yes', 'y', '1', 'on', 'checked'])
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'f', 'no', 'n', '0', 'off', 'unchecked'])

/** Read one value as yes or no. An unrecognised word is NOT no: it is undefined. */
export function readBoolean(value: string | boolean | number): boolean | undefined {
  if (typeof value === 'boolean') return value
  const word = String(value).trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  return undefined
}
