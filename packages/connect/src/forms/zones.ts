// SPDX-License-Identifier: MIT
/**
 * Time-zone arithmetic using only `Intl` (no dependency). A form stores a date-time in the zone of the account that
 * submits it, not the person's. Sending the person's wall-clock time unchanged stores the wrong moment. On a live
 * instance, 08:09 in Auckland was stored as 08:09 US Pacific, 21 hours off.
 */

type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function partsIn(instant: number, zone: string): Parts {
  let f = fmtCache.get(zone)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    fmtCache.set(zone, f)
  }
  const p: Record<string, number> = {}
  for (const x of f.formatToParts(new Date(instant))) if (x.type !== 'literal') p[x.type] = Number(x.value)
  return { y: p['year']!, mo: p['month']!, d: p['day']!, h: p['hour']! % 24, mi: p['minute']!, s: p['second']! }
}

/** True when the zone is a name `Intl` knows. */
export function isZone(zone: string): boolean {
  try { partsIn(0, zone); return true } catch { return false }
}

/** The zone's offset from UTC at that instant, in minutes (Auckland in November: +780). */
export function offsetMinutes(instant: number, zone: string): number {
  const p = partsIn(instant, zone)
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(instant / 1000) * 1000) / 60000)
}

/** The instant a wall-clock time in a zone names. */
export function instantOf(local: Parts, zone: string): number {
  const guess = Date.UTC(local.y, local.mo - 1, local.d, local.h, local.mi, local.s)
  const first = guess - offsetMinutes(guess, zone) * 60000
  const second = guess - offsetMinutes(first, zone) * 60000
  return second
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/
const ABSOLUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i

/**
 * Read a date-time answer. A time with `Z` or an offset is absolute. A wall-clock time is in `personZone`. `now` is
 * the given clock. Undefined means "not a date-time".
 */
export function readDateTime(text: string, personZone: string, now: () => number = Date.now): number | undefined {
  const t = text.trim()
  if (/^now$/i.test(t)) return now()
  if (ABSOLUTE.test(t)) { const ms = Date.parse(t.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); return Number.isNaN(ms) ? undefined : ms }
  const m = LOCAL.exec(t)
  if (m === null) return undefined
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined
  return instantOf({ y, mo, d, h, mi, s }, personZone)
}

const two = (n: number) => String(n).padStart(2, '0')

/** Write an instant the way the application wants it, in the application's zone. */
export function writeDateTime(instant: number, zone: string, style: 'local' | 'iso_offset' | 'iso_utc'): string {
  if (style === 'iso_utc') return new Date(Math.floor(instant / 1000) * 1000).toISOString().replace('.000Z', 'Z')
  const p = partsIn(instant, zone)
  const local = `${p.y}-${two(p.mo)}-${two(p.d)}${style === 'local' ? ' ' : 'T'}${two(p.h)}:${two(p.mi)}:${two(p.s)}`
  if (style === 'local') return local
  const off = offsetMinutes(instant, zone)
  const a = Math.abs(off)
  return `${local}${off < 0 ? '-' : '+'}${two(Math.floor(a / 60))}:${two(a % 60)}`
}
