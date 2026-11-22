/**
 * Plain paths into JSON: `fields.priority.name`, `items[2].id`, `items.2.id`. No wildcards, no filters, no
 * expressions — a path names one place. An empty path is the value itself.
 */

/** The steps of a path. */
function steps(path: string): string[] {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter((s) => s !== '')
}

/** Read the value at a path, or undefined. */
export function getAt(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const s of steps(path)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = Array.isArray(cur) ? (/^\d+$/.test(s) ? cur[Number(s)] : undefined) : (cur as Record<string, unknown>)[s]
  }
  return cur
}

const UNSAFE = new Set(['__proto__', 'prototype', 'constructor'])

/** Write a value at a path, making objects on the way. Refuses names that would reach an object's prototype. */
export function setAt(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = steps(path)
  if (parts.length === 0 || parts.some((p) => UNSAFE.has(p))) throw new Error(`cannot write at "${path}"`)
  let cur: Record<string, unknown> = root
  for (const [i, s] of parts.entries()) {
    if (i === parts.length - 1) { cur[s] = value; return }
    const next = cur[s]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[s] = {}
    cur = cur[s] as Record<string, unknown>
  }
}
