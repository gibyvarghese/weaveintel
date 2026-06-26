// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 5 — the "Connections" panel for a note.
 *
 * --- For someone new to this ---
 * This shows how a note connects to the rest of your notes — like the side panel in
 * Obsidian. Four things:
 *   • Backlinks — other notes that point AT this one (via a [[wiki-link]]).
 *   • Unlinked mentions — notes whose title you typed here in plain text but didn't
 *     turn into a link yet (one-click candidates to connect).
 *   • Related notes — notes that are about similar things, found by meaning (an AI
 *     "embedding"), even if you never linked them.
 *   • A tiny knowledge GRAPH — a picture of this note, the notes it links to, and the
 *     people/concepts (entities) the AI found in it.
 *
 * "Index" asks the server to (re)compute all of this for the note: resolve its
 * [[links]], extract entities/relations with the AI, and embed it for the related-
 * notes search.
 */
import { h } from './dom.js';
import { api } from './api.js';

export interface NoteConnectionsPanel {
  /** Re-fetch + re-render all four sections. */
  refresh(): Promise<void>;
  /** Ask the server to (re)index the note (links + entities + embedding), then refresh. */
  index(): Promise<void>;
  close(): void;
}

interface Backlink { noteId: string; title: string }
interface Unlinked { noteId: string; title: string; count: number }
interface Related { noteId: string; title: string; score: number }
interface GraphNode { id: string; label: string; kind: 'note' | 'entity'; type?: string }
interface GraphEdge { source: string; target: string; label: string }

export function wireNoteConnections(opts: { noteId: string; panelEl: HTMLElement; onOpenNote: (id: string) => void }): NoteConnectionsPanel {
  const { noteId, panelEl, onOpenNote } = opts;

  function section(title: string, body: HTMLElement): HTMLElement {
    return h('div', { className: 'notes-conn-section' }, h('div', { className: 'notes-conn-title' }, title), body);
  }
  function noteChip(id: string, label: string, extra?: string): HTMLElement {
    return h('button', { className: 'notes-conn-chip', onClick: () => onOpenNote(id) }, label + (extra ? ` ${extra}` : ''));
  }

  async function get<T>(path: string, fallback: T): Promise<T> {
    try { const res = await api.get(`/api/me/notes/${noteId}/${path}`); return res.ok ? (await res.json() as T) : fallback; } catch { return fallback; }
  }

  /** Tiny SVG knowledge graph: the note in the centre, neighbours around a circle. */
  function renderGraph(g: { nodes: GraphNode[]; edges: GraphEdge[] }): HTMLElement {
    const W = 320, H = 240, cx = W / 2, cy = H / 2, R = 92;
    if (g.nodes.length <= 1) return h('div', { className: 'notes-conn-empty' }, 'Index the note to build its graph.');
    const center = g.nodes[0]!; // the note itself is first
    const others = g.nodes.slice(1);
    const pos = new Map<string, { x: number; y: number }>();
    pos.set(center.id, { x: cx, y: cy });
    others.forEach((n, i) => {
      const a = (i / Math.max(1, others.length)) * Math.PI * 2;
      pos.set(n.id, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R });
    });
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'notes-conn-graph');
    for (const e of g.edges) {
      const a = pos.get(e.source), b = pos.get(e.target); if (!a || !b) continue;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
      line.setAttribute('stroke', '#9aa4b2'); line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
    }
    for (const n of g.nodes) {
      const p = pos.get(n.id); if (!p) continue;
      const circ = document.createElementNS(ns, 'circle');
      circ.setAttribute('cx', String(p.x)); circ.setAttribute('cy', String(p.y));
      circ.setAttribute('r', n.kind === 'note' ? '8' : '5');
      circ.setAttribute('fill', n.kind === 'note' ? '#4f8cff' : '#b07cff');
      svg.appendChild(circ);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(p.x + 10)); label.setAttribute('y', String(p.y + 4));
      label.setAttribute('font-size', '10'); label.setAttribute('fill', '#444');
      label.textContent = n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label;
      svg.appendChild(label);
    }
    const wrap = h('div', {});
    wrap.appendChild(svg);
    return wrap;
  }

  async function refresh(): Promise<void> {
    panelEl.innerHTML = '';
    panelEl.appendChild(h('div', { className: 'notes-conn-loading' }, 'Loading connections…'));
    const [backlinks, unlinkedRes, relatedRes, graph] = await Promise.all([
      get<{ backlinks: Backlink[] }>('backlinks', { backlinks: [] }),
      get<{ unlinked: Unlinked[] }>('unlinked', { unlinked: [] }),
      get<{ related: Related[] }>('related', { related: [] }),
      get<{ nodes: GraphNode[]; edges: GraphEdge[] }>('graph', { nodes: [], edges: [] }),
    ]);
    panelEl.innerHTML = '';

    panelEl.appendChild(h('div', { className: 'notes-conn-header' },
      h('span', { className: 'notes-conn-heading' }, '🔗 Connections'),
      h('button', { className: 'notes-conn-index-btn', title: 'Re-index this note (links + entities + related)', onClick: () => void index() }, '↻ Index'),
    ));

    panelEl.appendChild(section(`Backlinks (${backlinks.backlinks.length})`,
      backlinks.backlinks.length
        ? h('div', { className: 'notes-conn-list' }, ...backlinks.backlinks.map((b) => noteChip(b.noteId, b.title)))
        : h('div', { className: 'notes-conn-empty' }, 'No notes link here yet.')));

    panelEl.appendChild(section(`Unlinked mentions (${unlinkedRes.unlinked.length})`,
      unlinkedRes.unlinked.length
        ? h('div', { className: 'notes-conn-list' }, ...unlinkedRes.unlinked.map((u) => noteChip(u.noteId, u.title, `(${u.count})`)))
        : h('div', { className: 'notes-conn-empty' }, 'No unlinked mentions.')));

    panelEl.appendChild(section(`Related notes (${relatedRes.related.length})`,
      relatedRes.related.length
        ? h('div', { className: 'notes-conn-list' }, ...relatedRes.related.map((r) => noteChip(r.noteId, r.title, `· ${(r.score * 100).toFixed(0)}%`)))
        : h('div', { className: 'notes-conn-empty' }, 'No related notes yet — try Index.')));

    panelEl.appendChild(section('Knowledge graph', renderGraph(graph)));
  }

  async function index(): Promise<void> {
    panelEl.innerHTML = '';
    panelEl.appendChild(h('div', { className: 'notes-conn-loading' }, 'Indexing — resolving links, extracting entities, embedding…'));
    try { await api.post(`/api/me/notes/${noteId}/index`, {}); } catch { /* show whatever we can */ }
    await refresh();
  }

  void refresh();
  return { refresh, index, close() { /* nothing live to release */ } };
}
