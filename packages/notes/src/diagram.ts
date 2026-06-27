// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the native DIAGRAM model + renderer (weaveNotes Phase 4).
 *
 * "Sketch a colour-coded flow of these 4 steps" should give you a real, editable, intentionally
 * coloured diagram — not a flat picture. The mid-2026 way an LLM makes a diagram is to emit
 * STRUCTURED JSON (nodes + edges), which a renderer lays out and draws. So a weaveNotes diagram
 * is just that data: a list of labelled, coloured nodes and the edges between them. It stays
 * native + editable (you can recolour a node, change a label, add an edge) and is the SAME shape
 * whether a human or the AI made it — no AI-specific format.
 *
 * This module owns that model + how it becomes a picture, all pure + zero-dependency:
 *   - `validateDiagramScene` — the strict gate over a (possibly AI- or client-supplied) scene:
 *     cap node/edge counts, dedupe ids, cap label lengths, resolve every colour to a
 *     PRE-VALIDATED WCAG-AA pastel (so dark text on a node is always legible), drop dangling edges;
 *   - `layoutDiagram` — a dependency-free LAYERED left-to-right layout (rank by BFS depth), which
 *     handles flows, trees/mind-maps, and small graphs;
 *   - `diagramToSvg` — render the laid-out scene to a self-contained `<svg>` with rounded nodes,
 *     arrowed edges, and centred labels (for the editor, a share, and the exported artifact).
 */
import { HIGHLIGHT_PALETTE, READING_INK } from './colorize.js';
import { sanitizeColor } from './creative.js';

export type DiagramKind = 'flow' | 'mindmap' | 'graph';
export type NodeShape = 'box' | 'pill' | 'diamond' | 'ellipse';

/** A diagram node: a labelled, coloured shape. `color` is a swatch label or hex (validated to a safe pastel). */
export interface DiagramNode { id: string; label: string; color?: string; shape?: NodeShape }
/** A directed edge between two node ids, optionally labelled/coloured. */
export interface DiagramEdge { from: string; to: string; label?: string; color?: string }
/** A whole diagram scene (the node data stored in the `diagram` block). */
export interface DiagramScene { kind?: DiagramKind; title?: string; nodes: DiagramNode[]; edges: DiagramEdge[] }

const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_LABEL = 80;

/** Resolve a colour intent (swatch label / hex) to a PRE-VALIDATED WCAG-AA pastel fill. */
function nodeFill(color: string | undefined, index: number): string {
  if (color) {
    const byLabel = HIGHLIGHT_PALETTE.find((p) => p.label === String(color).trim().toLowerCase());
    if (byLabel) return byLabel.color;
    const hex = sanitizeColor(color);
    // Accept a client hex only if it's a light pastel (so the dark label stays legible); else fall back.
    if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (lum >= 0.6) return hex;
    }
  }
  return HIGHLIGHT_PALETTE[index % HIGHLIGHT_PALETTE.length]!.color;
}

/** A slightly darker stroke for a fill colour (a fixed darken, deterministic). */
function darken(hex: string, amount = 0.35): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return READING_INK;
  const f = (i: number): string => {
    const v = Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount));
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  };
  return `#${f(1)}${f(3)}${f(5)}`;
}

/**
 * Validate + normalise a (possibly hostile) scene: cap counts, dedupe + slug ids, cap labels,
 * resolve every node colour to a safe WCAG-AA pastel, keep only a known shape, and DROP any edge
 * whose endpoints aren't real nodes. Always returns a renderable scene (≥1 node).
 */
export function validateDiagramScene(input: unknown): DiagramScene {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind: DiagramKind = s['kind'] === 'mindmap' || s['kind'] === 'graph' ? s['kind'] : 'flow';
  const title = typeof s['title'] === 'string' ? s['title'].slice(0, MAX_LABEL) : undefined;

  const rawNodes = Array.isArray(s['nodes']) ? (s['nodes'] as unknown[]).slice(0, MAX_NODES) : [];
  const nodes: DiagramNode[] = [];
  const ids = new Set<string>();
  let auto = 0;
  for (const rn of rawNodes) {
    if (!rn || typeof rn !== 'object') continue;
    const n = rn as Record<string, unknown>;
    let id = typeof n['id'] === 'string' && n['id'].trim() ? n['id'].trim().slice(0, 64) : `n${auto}`;
    while (ids.has(id)) id = `${id}_${auto}`;
    ids.add(id); auto += 1;
    const label = typeof n['label'] === 'string' ? n['label'].slice(0, MAX_LABEL) : (typeof n['text'] === 'string' ? (n['text'] as string).slice(0, MAX_LABEL) : id);
    const shape: NodeShape = n['shape'] === 'diamond' || n['shape'] === 'ellipse' || n['shape'] === 'pill' ? n['shape'] : 'box';
    nodes.push({ id, label, color: nodeFill(typeof n['color'] === 'string' ? n['color'] : undefined, nodes.length), shape });
  }
  if (nodes.length === 0) nodes.push({ id: 'n0', label: title ?? 'Diagram', color: HIGHLIGHT_PALETTE[0]!.color, shape: 'box' });

  const rawEdges = Array.isArray(s['edges']) ? (s['edges'] as unknown[]).slice(0, MAX_EDGES) : [];
  const edges: DiagramEdge[] = [];
  for (const re of rawEdges) {
    if (!re || typeof re !== 'object') continue;
    const e = re as Record<string, unknown>;
    const from = String(e['from'] ?? ''); const to = String(e['to'] ?? '');
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    edges.push({ from, to, ...(typeof e['label'] === 'string' ? { label: e['label'].slice(0, MAX_LABEL) } : {}), ...(typeof e['color'] === 'string' && sanitizeColor(e['color']) ? { color: sanitizeColor(e['color'])! } : {}) });
  }
  return { kind, ...(title ? { title } : {}), nodes, edges };
}

// ─── Layout ─────────────────────────────────────────────────────────────────────────────

export interface PlacedNode extends DiagramNode { x: number; y: number; w: number; h: number }
export interface DiagramLayout { nodes: PlacedNode[]; width: number; height: number; titleH: number }

const NODE_H = 46;
const GAP_X = 64;
const GAP_Y = 22;
const MARGIN = 16;

function nodeWidth(label: string): number { return Math.max(84, Math.min(220, label.length * 8 + 28)); }

/** Assign each node a position via a layered left-to-right layout (rank = BFS depth from roots). */
export function layoutDiagram(scene: DiagramScene): DiagramLayout {
  const { nodes, edges } = scene;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue; // skip dangling edges (layout may get a raw scene)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.get(e.from)!.push(e.to);
  }

  // Rank by BFS from the roots (in-degree 0); nodes never reached get the next rank.
  const rank = new Map<string, number>();
  let queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (queue.length === 0 && nodes.length) queue = [nodes[0]!.id];
  for (const id of queue) rank.set(id, 0);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!; const r = rank.get(id) ?? 0;
    for (const to of adj.get(id) ?? []) { if (!rank.has(to)) { rank.set(to, r + 1); queue.push(to); } }
  }
  let maxRank = 0;
  for (const n of nodes) { if (!rank.has(n.id)) rank.set(n.id, maxRank + 1); maxRank = Math.max(maxRank, rank.get(n.id)!); }

  // Group by rank, place columns left→right, stack within a column.
  const cols = new Map<number, string[]>();
  for (const n of nodes) { const r = rank.get(n.id)!; (cols.get(r) ?? cols.set(r, []).get(r)!).push(n.id); }
  const titleH = scene.title ? 28 : 0;
  const placed: PlacedNode[] = [];
  let x = MARGIN;
  let maxColH = 0;
  const sortedRanks = [...cols.keys()].sort((a, b) => a - b);
  const colWidths: number[] = [];
  for (const r of sortedRanks) {
    const ids = cols.get(r)!;
    const colW = Math.max(...ids.map((id) => nodeWidth(byId.get(id)!.label)));
    colWidths.push(colW);
    let y = MARGIN + titleH;
    for (const id of ids) {
      const n = byId.get(id)!;
      placed.push({ ...n, x, y, w: colW, h: NODE_H });
      y += NODE_H + GAP_Y;
    }
    maxColH = Math.max(maxColH, y - GAP_Y);
    x += colW + GAP_X;
  }
  const width = x - GAP_X + MARGIN;
  const height = maxColH + MARGIN;
  return { nodes: placed, width: Math.max(width, 160), height: Math.max(height, 80), titleH };
}

// ─── Render ─────────────────────────────────────────────────────────────────────────────

const SVG_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string { return s.replace(/[&<>"']/g, (c) => SVG_ESC[c]!); }

/** Render a diagram scene to a self-contained `<svg>` (rounded coloured nodes + arrowed edges). */
export function diagramToSvg(scene: DiagramScene): string {
  const layout = layoutDiagram(scene);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  parts.push(`<defs><marker id="gw-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="${READING_INK}"/></marker></defs>`);
  if (scene.title) parts.push(`<text x="${layout.width / 2}" y="18" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="${READING_INK}">${esc(scene.title)}</text>`);

  // Edges first (under the nodes).
  for (const e of scene.edges) {
    const a = byId.get(e.from); const b = byId.get(e.to); if (!a || !b) continue;
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    const stroke = e.color && sanitizeColor(e.color) ? sanitizeColor(e.color)! : READING_INK;
    parts.push(`<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${esc(stroke)}" stroke-width="1.5" marker-end="url(#gw-arrow)" opacity="0.8"/>`);
    if (e.label) parts.push(`<text x="${mx}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#5E6E67">${esc(e.label)}</text>`);
  }
  // Nodes.
  for (const n of layout.nodes) {
    const fill = n.color ?? HIGHLIGHT_PALETTE[0]!.color;
    const stroke = darken(fill);
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    if (n.shape === 'diamond') {
      parts.push(`<polygon points="${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
    } else if (n.shape === 'ellipse') {
      parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${n.w / 2}" ry="${n.h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
    } else {
      const rx = n.shape === 'pill' ? n.h / 2 : 10;
      parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
    }
    parts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="${READING_INK}">${esc(n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label)}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" class="gw-diagram">${parts.join('')}</svg>`;
}
