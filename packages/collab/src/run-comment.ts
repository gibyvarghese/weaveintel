// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collaboration — Collaborative run comments.
 *
 * Google-Docs-grade review on an AI run: reviewers leave THREADED comments
 * ANCHORED to a specific part/step of the run (a tool call, a reasoning step, a
 * paragraph of output), @mention teammates, and resolve threads.
 *
 * --- For someone new to this ---
 * A "run" is a transcript made of typed PARTS — some text here, a tool call
 * there, a reasoning step. A comment is a sticky note pinned to ONE of those
 * parts ("this tool call used the wrong argument"). Replies hang off the first
 * note to form a THREAD, and a thread can be marked RESOLVED (done) or reopened —
 * exactly like comments in a shared doc.
 *
 * Anchoring (mid-2026 research — Notion block comments + W3C Web Annotation
 * `TextQuoteSelector` + Hypothesis fuzzy-anchoring): we anchor to the **stable
 * part id**, never a character offset into the whole run (a streaming part grows,
 * so an offset captured early points at the wrong place later). We also record
 * the run `sequence` at anchor time so a viewer can tell a comment is "stale"
 * (the part changed after it was written) without ever LOSING the comment. An
 * optional sub-range carries the quoted text + a little surrounding context so a
 * highlight can re-anchor fuzzily if the part text shifts.
 *
 * Ports & adapters (Phase 0–3 pattern): the {@link CommentManager} PORT + an
 * in-memory reference adapter live here; a consuming application provides a SQL adapter over
 * `run_comments`. Both pass {@link commentManagerContract}. Markdown is rendered
 * to SAFE html by {@link renderCommentMarkdown} (server-side source of truth) so
 * no adapter can store an XSS payload.
 */

/**
 * Where a comment is pinned. We anchor to a STABLE part id (e.g. `tool-3`),
 * with the run sequence captured for staleness, and an optional fuzzy sub-range.
 * `partId === ''` means the comment is on the run as a whole (not a single part).
 */
export interface CommentAnchor {
  /** Stable reducer part id (e.g. `text-2`, `tool-3`, `step-1`). '' = run-level. */
  partId: string;
  /** Run event sequence at anchor time — for staleness ("part changed since"). */
  createdAtSeq: number;
  /** Optional highlight inside the part (W3C TextQuoteSelector-style, fuzzy). */
  subRange?: {
    startOffset: number;
    endOffset: number;
    quotedText: string;
    prefix?: string;
    suffix?: string;
  };
}

export interface RunComment {
  id: string;
  runId: string;
  tenantId: string;
  /** Root comment id of the thread (root.threadId === root.id). */
  threadId: string;
  /** Reply provenance (the comment this one replies to); null for a root. */
  parentId: string | null;
  authorId: string;
  /** Raw markdown — the source of truth. */
  body: string;
  /** Sanitized HTML render cache (never trust this as input; re-render on edit). */
  bodyHtml: string;
  /** Mentioned user ids (validated against run access by the host). */
  mentions: string[];
  anchor: CommentAnchor;
  createdAt: number;
  updatedAt: number;
  /** Set only when the BODY changes (drives the "(edited)" marker); null otherwise. */
  editedAt: number | null;
  /** Soft-delete tombstone — the row stays so replies are not orphaned. */
  deletedAt: number | null;
  deletedBy: string | null;
  /** Thread-level resolution (mirrored on every comment in the thread for reads). */
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface CreateCommentInput {
  id: string;
  runId: string;
  tenantId: string;
  authorId: string;
  body: string;
  /** Reply to this comment (inherits its thread); omit/null for a new thread. */
  parentId?: string | null;
  mentions?: string[];
  anchor: CommentAnchor;
}

export interface CommentManager {
  /** Create a root comment (new thread) or a reply (inherits the parent's thread). */
  create(input: CreateCommentInput): Promise<RunComment>;
  getById(id: string): Promise<RunComment | null>;
  /** All comments on a run (incl. tombstones; excl. hard-deleted), oldest first. */
  listForRun(runId: string): Promise<RunComment[]>;
  /** Every comment in a thread, oldest first. */
  listThread(threadId: string): Promise<RunComment[]>;
  /** Edit the body — AUTHOR ONLY (throws otherwise). Re-renders + stamps editedAt. */
  edit(id: string, byUserId: string, body: string, mentions?: string[]): Promise<RunComment>;
  /**
   * Soft-delete (tombstone). The author may always delete; a moderator (run
   * owner) may delete others' via `{ force: true }`. Replies are preserved.
   */
  softDelete(id: string, byUserId: string, opts?: { force?: boolean }): Promise<void>;
  /** Resolve a whole thread (mark done). Records who resolved it. */
  resolveThread(threadId: string, byUserId: string): Promise<void>;
  /** Reopen a resolved thread. */
  reopenThread(threadId: string, byUserId: string): Promise<void>;
}

// ─── Safe markdown rendering ────────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/**
 * Render a comment's markdown to SAFE html (mid-2026 research: render → then
 * sanitize against a strict allowlist; CommonMark alone is NOT safe —
 * `[x](javascript:…)` is valid markdown). Strategy: escape ALL html first (so no
 * raw tag, attribute, or `javascript:` URL can survive), THEN apply a tiny
 * allowlist of inline formatting on the already-escaped text. The output can only
 * ever contain the handful of tags we emit here.
 *
 * Supported: `**bold**`, `*italic*`, `` `code` ``, `[text](http(s)://url)`,
 * `@mention` highlight, and newline → `<br>`. Anything else renders as plain text.
 */
export function renderCommentMarkdown(body: string): string {
  let s = escapeHtml(body.slice(0, 10_000)); // hard length cap (anti-abuse)
  // Links: [text](http(s)://...) — ONLY http/https (no javascript:, data:, etc.).
  // Operates on escaped text, so `text`/`url` are already safe.
  s = s.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g,
    (_m, text: string, url: string) => `<a href="${url}" rel="noopener noreferrer nofollow" target="_blank">${text}</a>`);
  // Inline code (before bold/italic so * inside code is literal).
  s = s.replace(/`([^`\n]{1,500})`/g, (_m, code: string) => `<code>${code}</code>`);
  // Bold then italic.
  s = s.replace(/\*\*([^*\n]{1,500})\*\*/g, (_m, t: string) => `<strong>${t}</strong>`);
  s = s.replace(/\*([^*\n]{1,500})\*/g, (_m, t: string) => `<em>${t}</em>`);
  // @mentions — cosmetic highlight (the structured mention list drives notifies).
  s = s.replace(/(^|\s)@([a-zA-Z0-9._-]{1,64})/g, (_m, pre: string, name: string) => `${pre}<span class="mention">@${name}</span>`);
  // Newlines → <br>.
  s = s.replace(/\r?\n/g, '<br>');
  return s;
}

// ─── In-memory reference adapter ────────────────────────────────────────────────

export interface InMemoryCommentManagerOptions {
  now?: () => number;
}

export function createInMemoryCommentManager(opts: InMemoryCommentManagerOptions = {}): CommentManager {
  const now = opts.now ?? (() => Date.now());
  const comments = new Map<string, RunComment>();

  /** Apply the thread's resolution state to a single comment (read-time mirror). */
  function withThreadResolution(c: RunComment): RunComment {
    const root = comments.get(c.threadId);
    return root ? { ...c, resolvedAt: root.resolvedAt, resolvedBy: root.resolvedBy } : c;
  }

  return {
    async create(input) {
      const parent = input.parentId ? comments.get(input.parentId) : undefined;
      if (input.parentId && !parent) throw new Error(`parent comment '${input.parentId}' not found`);
      if (parent && parent.runId !== input.runId) throw new Error('reply must target the same run as its parent');
      const threadId = parent ? parent.threadId : input.id; // root: thread === self
      const ts = now();
      const comment: RunComment = {
        id: input.id, runId: input.runId, tenantId: input.tenantId,
        threadId, parentId: input.parentId ?? null, authorId: input.authorId,
        body: input.body, bodyHtml: renderCommentMarkdown(input.body),
        mentions: [...new Set(input.mentions ?? [])],
        anchor: input.anchor,
        createdAt: ts, updatedAt: ts, editedAt: null,
        deletedAt: null, deletedBy: null, resolvedAt: null, resolvedBy: null,
      };
      comments.set(comment.id, comment);
      return withThreadResolution(comment);
    },
    async getById(id) {
      const c = comments.get(id);
      return c ? withThreadResolution(c) : null;
    },
    async listForRun(runId) {
      return [...comments.values()].filter((c) => c.runId === runId)
        .sort((a, b) => a.createdAt - b.createdAt).map(withThreadResolution);
    },
    async listThread(threadId) {
      return [...comments.values()].filter((c) => c.threadId === threadId)
        .sort((a, b) => a.createdAt - b.createdAt).map(withThreadResolution);
    },
    async edit(id, byUserId, body, mentions) {
      const c = comments.get(id);
      if (!c) throw new Error(`comment '${id}' not found`);
      if (c.deletedAt) throw new Error('cannot edit a deleted comment');
      if (c.authorId !== byUserId) throw new Error('forbidden: only the author may edit a comment');
      const ts = now();
      const updated: RunComment = {
        ...c, body, bodyHtml: renderCommentMarkdown(body),
        ...(mentions ? { mentions: [...new Set(mentions)] } : {}),
        updatedAt: ts, editedAt: ts,
      };
      comments.set(id, updated);
      return withThreadResolution(updated);
    },
    async softDelete(id, byUserId, opts2) {
      const c = comments.get(id);
      if (!c) return;
      if (c.authorId !== byUserId && !opts2?.force) throw new Error('forbidden: only the author (or a moderator) may delete a comment');
      const ts = now();
      comments.set(id, { ...c, body: '', bodyHtml: '', mentions: [], deletedAt: ts, deletedBy: byUserId, updatedAt: ts });
    },
    async resolveThread(threadId, byUserId) {
      const root = comments.get(threadId);
      if (!root) throw new Error(`thread '${threadId}' not found`);
      comments.set(threadId, { ...root, resolvedAt: now(), resolvedBy: byUserId, updatedAt: now() });
    },
    async reopenThread(threadId, byUserId) {
      const root = comments.get(threadId);
      if (!root) throw new Error(`thread '${threadId}' not found`);
      comments.set(threadId, { ...root, resolvedAt: null, resolvedBy: null, updatedAt: now() });
      void byUserId;
    },
  };
}
