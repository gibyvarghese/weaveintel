// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collab — Agent as a co-editing peer.
 *
 * The AI agent is just another CRDT replica: a SERVER-SIDE editor with its own
 * site id that streams its output into the shared document as insert ops. Because
 * it is a normal peer, its edits merge with concurrent human edits automatically
 * — no locking, no "the agent overwrote my paragraph".
 *
 * --- For someone new to this ---
 * When the AI writes, each chunk of its text becomes "insert these characters
 * after that character" — exactly the same kind of edit a human makes. So a human
 * and the agent can be typing into the same document at once and it all merges.
 *
 * Mode (mid-2026 research): a 2025 user study found people prefer the agent as a
 * SUGGESTER for large/overlapping edits (tracked changes they accept) over direct
 * co-editing. This helper supports both: `direct` applies straight to the doc;
 * `suggest` returns the ops WITHOUT applying, for the host to gate behind human
 * approval. The default is `direct` for small, clearly-scoped insertions.
 */
import type { CoeditDoc, CoeditOp } from './coedit-doc.js';

/** A reserved site-id prefix so an agent peer is visually + programmatically distinct. */
export const AGENT_SITE_PREFIX = 'agent:';

export function agentSiteId(runId: string): string {
  return `${AGENT_SITE_PREFIX}${runId}`;
}
export function isAgentSite(siteId: string): boolean {
  return siteId.startsWith(AGENT_SITE_PREFIX);
}

export interface AgentPeer {
  readonly doc: CoeditDoc;
  /** Append text at the END of the document; returns the ops (applied if mode=direct). */
  append(text: string): CoeditOp[];
  /** Insert text at a visible index; returns the ops. */
  insertAt(index: number, text: string): CoeditOp[];
  /** How many characters this agent peer has already contributed (for incremental streaming). */
  written(): number;
}

export interface AgentPeerOptions {
  /** `direct` = apply immediately (default); `suggest` = return ops without applying (HITL gate). */
  mode?: 'direct' | 'suggest';
}

/**
 * Wrap a {@link CoeditDoc} (whose `siteId` should be an {@link agentSiteId}) as an
 * agent co-editor. In `direct` mode edits are applied to the doc and the ops
 * returned for broadcast; in `suggest` mode the ops are returned WITHOUT being
 * applied (the host stages them as suggestions for a human to accept).
 *
 * It talks only to the {@link CoeditDoc} PORT — never to a concrete CRDT engine — so the
 * AI-as-editing-peer keeps working unchanged if the engine underneath is ever swapped.
 */
export function createAgentPeer(doc: CoeditDoc, opts: AgentPeerOptions = {}): AgentPeer {
  const mode = opts.mode ?? 'direct';
  let written = 0;

  const emit = (index: number, text: string): CoeditOp[] => {
    if (text.length === 0) return [];
    if (mode === 'suggest') {
      // Compute ops against an independent fork so the live doc is untouched.
      const shadow = doc.fork(doc.siteId);
      const ops = shadow.insert(index, text);
      written += [...text].length;
      return ops;
    }
    const ops = doc.insert(index, text);
    written += [...text].length;
    return ops;
  };

  return {
    doc,
    append(text) { return emit(doc.length, text); },
    insertAt(index, text) { return emit(index, text); },
    written() { return written; },
  };
}
