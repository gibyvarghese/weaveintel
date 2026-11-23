/**
 * Wire encodings: how a value is WRITTEN for one service, both ways (a closed list, {@link ENCODINGS}).
 *
 * WHY NOT TRANSFORMS
 * Transforms change what a value means and are one contract with schemaWeave inbound (contract v1, golden vectors in
 * both libraries). An encoding only changes the wire shape for the outbound runner: the same plain text a person typed
 * is an Atlassian Document Format document on Jira's wire, and comes back as plain text. Keeping encodings separate
 * means a connector pack can say "this field is ADF on the wire" with a row, and the shared transform contract does
 * not change for a concern inbound data never has.
 *
 * Every encoding is a pure function of the value. A value it cannot read is passed through unchanged on the way out
 * (the service's own check refuses it visibly) and passed through on the way in.
 */
import type { Encoding } from './spec.js'

type AdfNode = { readonly type: string; readonly text?: string; readonly content?: readonly AdfNode[]; readonly attrs?: Readonly<Record<string, unknown>> }

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'panel', 'rule', 'tableRow', 'mediaSingle'])

/** Plain text to an ADF document: blank lines separate paragraphs; a single newline is a hard break. */
function textToAdf(text: string): AdfNode {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.replace(/^\n+|\n+$/g, '')).filter((p) => p.trim() !== '')
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i) => [...(i > 0 ? [{ type: 'hardBreak' }] : []), ...(line === '' ? [] : [{ type: 'text', text: line }])]),
    })),
  } as AdfNode
}

/** An ADF document to plain text: each block on its own paragraph, hard breaks as newlines, mentions and emoji as their text. */
function adfToText(node: unknown): string {
  const blocks: string[] = []
  let line = ''
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    const x = n as AdfNode
    if (x.type === 'text' && typeof x.text === 'string') { line += x.text; return }
    if (x.type === 'hardBreak') { line += '\n'; return }
    if (x.type === 'mention' || x.type === 'emoji' || x.type === 'status' || x.type === 'date') {
      const a = x.attrs ?? {}
      line += String(a['text'] ?? a['shortName'] ?? a['timestamp'] ?? '')
      return
    }
    const block = BLOCKS.has(x.type)
    if (block && line !== '') { blocks.push(line); line = '' }
    for (const c of x.content ?? []) walk(c)
    if (block && line !== '') { blocks.push(line); line = '' }
  }
  walk(node)
  if (line !== '') blocks.push(line)
  return blocks.join('\n\n')
}

const isAdf = (v: unknown): boolean => v !== null && typeof v === 'object' && (v as AdfNode).type === 'doc'

/**
 * Encode a value for the wire.
 * @param encoding The row's encoding.
 * @param value The (already transformed) value.
 */
export function encodeValue(encoding: Encoding | undefined, value: unknown): unknown {
  switch (encoding ?? 'none') {
    case 'none': return value
    case 'adf_document': return typeof value === 'string' ? textToAdf(value) : value
    case 'comma_list': return Array.isArray(value) ? value.map((v) => String(v).trim()).filter((v) => v !== '').join(',') : value
    case 'json_text': return value === undefined ? undefined : JSON.stringify(value)
  }
}

/**
 * Decode a value read from the wire.
 * @param encoding The row's encoding.
 * @param value The value at the row's path.
 */
export function decodeValue(encoding: Encoding | undefined, value: unknown): unknown {
  switch (encoding ?? 'none') {
    case 'none': return value
    case 'adf_document': return isAdf(value) ? adfToText(value) : value
    case 'comma_list': return typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter((v) => v !== '') : value
    case 'json_text': {
      if (typeof value !== 'string') return value
      try { return JSON.parse(value) as unknown } catch { return value }
    }
  }
}
