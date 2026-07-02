// SPDX-License-Identifier: MIT
/**
 * @weaveintel/extraction — AI DATABASE auto-fill with citations (weaveNotes Phase 6).
 *
 * "Auto-fill" is the Notion-2026 feature where the AI fills a whole COLUMN of a table
 * from each row's context — a Summary, a Category, a Priority, an estimated cost — so
 * you don't type it by hand. The important, trustworthy bit is CITATIONS: the model
 * must say WHICH provided source it used for each cell, so a human can verify it
 * instead of taking an opaque guess on faith.
 *
 * This module is model-AGNOSTIC (you pass a `generate` callback) and pure: it owns the
 * prompt + the strict JSON parsing/sanitizing. The host (geneWeave) gathers each row's
 * context — the page, related rows in the workspace, and web-search snippets — labels
 * the sources with ids, and this returns a typed value + the cited source ids per row.
 *
 * --- For someone new to this ---
 * Imagine a spreadsheet where one empty column is "Founded year". Instead of looking
 * each company up yourself, the AI reads what we already know about each row (plus a
 * web search), writes the year, AND tells you which note or web page it got it from.
 * The citation is the receipt.
 */
import type { GenerateFn } from './knowledge-graph.js';

/** The column being filled. */
export interface AutofillProperty {
  /** Display name (e.g. "Summary", "Category"). */
  name: string;
  /** The column type — guides the expected value shape (text | number | select | …). */
  type: string;
  /** Optional human instruction ("one sentence", "USD"). */
  instruction?: string;
  /** Allowed values for select/multi_select columns. */
  options?: string[];
}

/** One row to fill, with its gathered context + the ids of the sources behind that context. */
export interface AutofillRow {
  rowId: string;
  /** A short label for the row (its title/name), for the prompt. */
  title?: string;
  /** The gathered context (the page text, related rows, web snippets…), each source labelled `[id]`. */
  context: string;
  /** The valid source ids the model may cite for THIS row (citations outside this set are dropped). */
  sourceIds?: string[];
}

/** The filled cell: a typed value + the source ids the model cited. */
export interface AutofillCell {
  rowId: string;
  value: unknown;
  citations: string[];
}

function parseJsonLoose(raw: string): unknown {
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(t); } catch { /* */ }
  const s = t.indexOf('['); const e = t.lastIndexOf(']');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { /* */ } }
  const so = t.indexOf('{'); const eo = t.lastIndexOf('}');
  if (so >= 0 && eo > so) { try { return JSON.parse(t.slice(so, eo + 1)); } catch { /* */ } }
  return null;
}

/** Light value coercion to the column type (the host re-validates against its schema). */
function coerce(value: unknown, type: string, options?: string[]): unknown {
  switch (type) {
    case 'number': { const n = typeof value === 'number' ? value : Number(value); return Number.isFinite(n) ? n : null; }
    case 'checkbox': return value === true || value === 'true' || value === 1;
    case 'select': { const s = value == null ? '' : String(value); return options && !options.includes(s) ? null : (s || null); }
    case 'multi_select': { const arr = Array.isArray(value) ? value.map(String) : String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean); return options ? arr.filter((x) => options.includes(x)) : arr; }
    default: return value == null ? null : (typeof value === 'string' ? value.trim() : String(value));
  }
}

export interface AutofillOptions {
  /** Bound each row's context sent to the model (default 2500 chars). */
  maxContextChars?: number;
}

/**
 * Fill the `property` for every row in `rows` from each row's context, returning a typed
 * value + the cited source ids per row. Model output is strictly parsed; citations are
 * filtered to each row's declared `sourceIds`; never throws (returns empty on bad output).
 */
export async function autofillProperty(
  input: { property: AutofillProperty; rows: AutofillRow[]; generate: GenerateFn },
  opts: AutofillOptions = {},
): Promise<AutofillCell[]> {
  const { property, rows, generate } = input;
  if (rows.length === 0) return [];
  const maxCtx = opts.maxContextChars ?? 2500;

  const optionsLine = property.options?.length ? `\nAllowed values (pick exactly one${property.type === 'multi_select' ? ' or more' : ''}): ${property.options.join(', ')}.` : '';
  const system = [
    `You fill the "${property.name}" column (type: ${property.type}) of a table from each row's context.`,
    property.instruction ? `Instruction: ${property.instruction}` : '',
    'Use ONLY the provided context for each row. If the answer is not supported by the context, use null.',
    'For every row, CITE the source ids (the [bracketed] labels) you used.',
    'Return ONLY a JSON array: [{"rowId":"...","value":<the value>,"citations":["sourceId",...]}].',
    optionsLine,
  ].filter(Boolean).join('\n');

  const user = rows.map((r, i) => `--- Row ${i + 1} (rowId: ${r.rowId})${r.title ? ` — ${r.title}` : ''} ---\nContext:\n${r.context.slice(0, maxCtx)}`).join('\n\n');

  let out = '';
  try { out = await generate({ system, user: `Fill the "${property.name}" value for each row:\n\n${user}`, temperature: 0, maxTokens: 1200 }); }
  catch { return []; }

  const parsed = parseJsonLoose(out);
  const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
  const byId = new Map(rows.map((r) => [r.rowId, new Set(r.sourceIds ?? [])]));
  const cells: AutofillCell[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rowId = String((item as { rowId?: unknown }).rowId ?? '');
    if (!byId.has(rowId) || seen.has(rowId)) continue;
    seen.add(rowId);
    const value = coerce((item as { value?: unknown }).value, property.type, property.options);
    const allowed = byId.get(rowId)!;
    const rawCites = (item as { citations?: unknown }).citations;
    const citations = Array.isArray(rawCites)
      ? [...new Set(rawCites.map(String).filter((c) => allowed.size === 0 || allowed.has(c)))]
      : [];
    cells.push({ rowId, value, citations });
  }
  return cells;
}
