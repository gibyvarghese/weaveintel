// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the INK model + renderer (weaveNotes Phase 4).
 *
 * weaveNotes lets you (and the AI) draw freehand strokes on a note — a blue underline, an arrow,
 * a circled word, a quick sketch. A stroke is stored as plain data — a list of points plus a
 * colour, width and tool — so a drawing inked on an iPad renders identically on the web, and the
 * AI can "draw" by emitting the SAME stroke data a human's pen produces (no AI-specific format).
 *
 * This module is the SINGLE SOURCE OF TRUTH for that stroke model + how it becomes a picture:
 *   - `strokeToPath` smooths a list of points into an SVG path (the lightweight cousin of
 *     perfect-freehand: streamline the points, then draw quadratic curves through their midpoints
 *     — clean, deterministic, zero-dependency, and good enough for notebook ink);
 *   - `strokesToSvg` renders a whole stroke set to a self-contained `<svg>` (for the editor, for a
 *     read-only share, and for the exported artifact);
 *   - `inkFromPrimitives` turns the AI's high-level intent ("underline", "arrow", "circle") into
 *     real strokes, so `draw_ink` produces genuinely editable ink, not a flat picture;
 *   - `validateStrokes` is the strict gate over any incoming (AI- or client-supplied) stroke data
 *     — bounded point counts, sane coordinates, a safe colour, a known tool — so a "drawing" can
 *     never carry script or blow up the document.
 *
 * Pure + zero-dependency (browser- and server-safe).
 */
import { sanitizeColor } from './color-safety.js';

/** One sampled pen point: position + optional pressure (0..1). */
export interface InkPoint { x: number; y: number; p?: number }

export type InkTool = 'pen' | 'highlighter' | 'eraser';

/** One freehand stroke: its points, colour, nib width, and which tool drew it. */
export interface InkStroke {
  points: InkPoint[];
  color: string;
  width: number;
  tool: InkTool;
  /** Optional author tag (agency colour: an AI-drawn stroke vs your own). */
  author?: 'user' | 'ai';
}

const MAX_STROKES = 400;
const MAX_POINTS = 4000;
const MAX_COORD = 100_000;
const DEFAULT_INK = '#14201B';

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

/** Streamline (low-pass) a point list so a shaky hand becomes a smooth line. */
function streamline(points: InkPoint[], amount = 0.5): InkPoint[] {
  if (points.length < 3) return points;
  const out: InkPoint[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = points[i]!;
    out.push({ x: prev.x + (cur.x - prev.x) * (1 - amount), y: prev.y + (cur.y - prev.y) * (1 - amount), ...(cur.p !== undefined ? { p: cur.p } : {}) });
  }
  return out;
}

/** Round to 2dp to keep the SVG compact + the round-trip stable. */
function r2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Smooth a list of points into an SVG path `d` string: move to the first point, then draw a
 * quadratic curve through the MIDPOINT of each pair of points (the classic "average + quadratic"
 * smoothing). Returns `''` for an empty list, or a dot for a single point.
 */
export function strokeToPath(points: InkPoint[], opts: { streamline?: number } = {}): string {
  const pts = streamline(points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), opts.streamline ?? 0.5);
  if (pts.length === 0) return '';
  if (pts.length === 1) { const p = pts[0]!; return `M ${r2(p.x)} ${r2(p.y)} l 0.01 0`; }
  let d = `M ${r2(pts[0]!.x)} ${r2(pts[0]!.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const cur = pts[i]!; const next = pts[i + 1]!;
    const mx = (cur.x + next.x) / 2; const my = (cur.y + next.y) / 2;
    d += ` Q ${r2(cur.x)} ${r2(cur.y)} ${r2(mx)} ${r2(my)}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` L ${r2(last.x)} ${r2(last.y)}`;
  return d;
}

/** The bounding box of a stroke set (with a small padding), for the SVG viewBox. */
export function strokesBounds(strokes: InkStroke[], pad = 8): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s.points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 320, h: 120 };
  return { x: minX - pad, y: minY - pad, w: Math.max(1, maxX - minX) + pad * 2, h: Math.max(1, maxY - minY) + pad * 2 };
}

const SVG_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string { return s.replace(/[&<>"']/g, (c) => SVG_ESC[c]!); }

/**
 * Render a stroke set to a self-contained `<svg>` string. Eraser strokes are skipped (they are a
 * UI gesture, not paint). The highlighter is drawn semi-transparent. Every colour is re-validated.
 */
export function strokesToSvg(strokes: InkStroke[], opts: { width?: number; height?: number } = {}): string {
  const b = strokesBounds(strokes);
  const vbW = opts.width ?? b.w;
  const vbH = opts.height ?? b.h;
  const paths = strokes
    .filter((s) => s.tool !== 'eraser' && s.points.length > 0)
    .map((s) => {
      const color = sanitizeColor(s.color) ?? DEFAULT_INK;
      const width = clampNum(s.width, 0.5, 64, 3);
      const opacity = s.tool === 'highlighter' ? 0.4 : 1;
      const d = strokeToPath(s.points);
      if (!d) return '';
      return `<path d="${esc(d)}" fill="none" stroke="${esc(color)}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`;
    })
    .filter(Boolean)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(b.x)} ${r2(b.y)} ${r2(vbW)} ${r2(vbH)}" width="${r2(vbW)}" height="${r2(vbH)}" class="gw-ink">${paths}</svg>`;
}

/**
 * Validate + normalise a (possibly hostile) stroke array: cap the number of strokes + points per
 * stroke, coerce coordinates into a sane range, validate each colour (drop a script-laden one →
 * default ink), clamp the width, and keep only known tools. Returns a clean `InkStroke[]`.
 */
export function validateStrokes(input: unknown): InkStroke[] {
  if (!Array.isArray(input)) return [];
  const out: InkStroke[] = [];
  for (const raw of input.slice(0, MAX_STROKES)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const ptsIn = Array.isArray(s['points']) ? (s['points'] as unknown[]).slice(0, MAX_POINTS) : [];
    const points: InkPoint[] = [];
    for (const pr of ptsIn) {
      if (!pr || typeof pr !== 'object') continue;
      const pp = pr as Record<string, unknown>;
      const x = Number(pp['x']); const y = Number(pp['y']);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const point: InkPoint = { x: clampNum(x, -MAX_COORD, MAX_COORD, 0), y: clampNum(y, -MAX_COORD, MAX_COORD, 0) };
      const p = Number(pp['p']); if (Number.isFinite(p)) point.p = clampNum(p, 0, 1, 0.5);
      points.push(point);
    }
    if (points.length === 0) continue;
    const tool: InkTool = s['tool'] === 'highlighter' || s['tool'] === 'eraser' ? s['tool'] : 'pen';
    out.push({
      points,
      color: sanitizeColor(s['color']) ?? DEFAULT_INK,
      width: clampNum(s['width'], 0.5, 64, 3),
      tool,
      ...(s['author'] === 'ai' || s['author'] === 'user' ? { author: s['author'] as 'ai' | 'user' } : {}),
    });
  }
  return out;
}

// ─── AI primitives → real strokes (so `draw_ink` produces editable ink, not a picture) ──────────

/** One high-level shape the AI can ask for. Coordinates are in note-canvas units (px). */
export type InkPrimitive =
  | { kind: 'underline'; x1: number; x2: number; y: number; color?: string; width?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color?: string; width?: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color?: string; width?: number }
  | { kind: 'box'; x: number; y: number; w: number; h: number; color?: string; width?: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; color?: string; width?: number }
  | { kind: 'check'; x: number; y: number; size?: number; color?: string; width?: number }
  // Freeform: the AI traces an organic outline as a real, editable stroke (open polyline or a
  // closed shape). `points` is `[{x,y}, …]`; `closed` joins the last point back to the first.
  | { kind: 'path'; points: Array<{ x: number; y: number }>; closed?: boolean; color?: string; width?: number }
  | { kind: 'dot'; cx: number; cy: number; color?: string; width?: number };

/** Turn the AI's high-level ink primitives into real, editable strokes. Hand-drawn, slightly loose. */
export function inkFromPrimitives(primitives: unknown): InkStroke[] {
  if (!Array.isArray(primitives)) return [];
  const strokes: InkStroke[] = [];
  for (const raw of primitives.slice(0, 60)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const color = sanitizeColor(p['color']) ?? '#3B6FB0';
    const width = clampNum(p['width'], 1, 24, 3);
    const num = (k: string, d = 0): number => clampNum(p[k], -MAX_COORD, MAX_COORD, d);
    const mk = (points: InkPoint[], tool: InkTool = 'pen'): void => { strokes.push({ points, color, width, tool, author: 'ai' }); };
    switch (p['kind']) {
      case 'underline': mk([{ x: num('x1'), y: num('y') }, { x: (num('x1') + num('x2')) / 2, y: num('y') + 1.5 }, { x: num('x2'), y: num('y') }]); break;
      case 'line': mk([{ x: num('x1'), y: num('y1') }, { x: num('x2'), y: num('y2') }]); break;
      case 'arrow': {
        const x1 = num('x1'), y1 = num('y1'), x2 = num('x2'), y2 = num('y2');
        const ang = Math.atan2(y2 - y1, x2 - x1); const hl = 12;
        mk([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
        mk([{ x: x2 - hl * Math.cos(ang - 0.4), y: y2 - hl * Math.sin(ang - 0.4) }, { x: x2, y: y2 }, { x: x2 - hl * Math.cos(ang + 0.4), y: y2 - hl * Math.sin(ang + 0.4) }]);
        break;
      }
      case 'box': { const x = num('x'), y = num('y'), w = num('w', 60), h = num('h', 40); mk([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]); break; }
      case 'circle': {
        const cx = num('cx'), cy = num('cy'), r = clampNum(p['r'], 1, MAX_COORD, 20);
        const pts: InkPoint[] = [];
        for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
        mk(pts); break;
      }
      case 'check': { const x = num('x'), y = num('y'), s = clampNum(p['size'], 4, 200, 16); mk([{ x, y: y + s * 0.5 }, { x: x + s * 0.4, y: y + s }, { x: x + s, y }]); break; }
      case 'dot': { const cx = num('cx'), cy = num('cy'); mk([{ x: cx, y: cy }, { x: cx + 0.5, y: cy + 0.5 }]); break; }
      case 'path': {
        const ptsIn = Array.isArray(p['points']) ? (p['points'] as unknown[]).slice(0, MAX_POINTS) : [];
        const pts: InkPoint[] = [];
        for (const pr of ptsIn) {
          if (!pr || typeof pr !== 'object') continue;
          const pp = pr as Record<string, unknown>;
          const x = Number(pp['x']); const y = Number(pp['y']);
          if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x: clampNum(x, -MAX_COORD, MAX_COORD, 0), y: clampNum(y, -MAX_COORD, MAX_COORD, 0) });
        }
        if (pts.length >= 2) { if (p['closed'] === true && pts.length >= 3) pts.push({ ...pts[0]! }); mk(pts); }
        break;
      }
      default: break;
    }
  }
  return strokes;
}

/** Recolour every (non-eraser) stroke — the `recolor_ink` primitive. Validates the new colour. */
export function recolorStrokes(strokes: InkStroke[], color: string): InkStroke[] {
  const c = sanitizeColor(color);
  if (!c) return strokes;
  return strokes.map((s) => (s.tool === 'eraser' ? s : { ...s, color: c }));
}
