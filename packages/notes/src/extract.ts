// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — pure content-extraction helpers.
 *
 * These walk a Tiptap/ProseMirror document tree (`doc_json`, parsed) and pull out
 * structured signals WITHOUT any I/O — so they are trivially unit-testable and
 * reusable by any host (the web app today, a mobile/CLI host tomorrow). The host
 * application previously inlined `extractTaskItems` inside an HTTP route; lifting it here is
 * part of the same seam (the route now imports it).
 *
 * --- For someone new to this ---
 * A note is stored as a tree of "nodes" (a heading node, a paragraph node, a
 * to-do node, …). `extractTaskItems` finds every UNCHECKED to-do that has text
 * and returns its label, so the app can turn it into a real task. It is a pure
 * function: same input → same output, no database, no network.
 */

/** The text of every UNCHECKED `taskItem` (to-do) in a ProseMirror doc, trimmed + non-empty. */
export function extractTaskItems(docJson: unknown): string[] {
  const titles: string[] = [];
  function textOf(node: Record<string, unknown>): string {
    const content = node['content'] as Array<Record<string, unknown>> | undefined;
    if (!content) return '';
    return content
      .flatMap((para) => ((para['content'] as Array<Record<string, unknown>> | undefined) ?? [])
        .filter((c) => c['type'] === 'text')
        .map((c) => String(c['text'] ?? '')))
      .join('')
      .trim();
  }
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n['type'] === 'taskItem' && n['attrs'] && (n['attrs'] as Record<string, unknown>)['checked'] === false) {
      const text = textOf(n);
      if (text) titles.push(text);
    }
    if (Array.isArray(n['content'])) for (const child of n['content']) walk(child);
  }
  walk(docJson);
  return titles;
}

/** Plain-text content of a ProseMirror doc (all `text` nodes joined) — handy for search/preview. */
export function extractPlainText(docJson: unknown): string {
  const parts: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n['type'] === 'text' && typeof n['text'] === 'string') parts.push(n['text']);
    if (Array.isArray(n['content'])) for (const child of n['content']) walk(child);
  }
  walk(docJson);
  return parts.join('');
}
