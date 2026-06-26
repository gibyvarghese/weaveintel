// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — Public API (Collaboration Phase 7).
 *
 * A small, zero-dependency CRDT co-editing toolkit so a human and an AI agent can
 * edit ONE document concurrently and always converge:
 *   - {@link RgaDoc}       — the RGA text CRDT (insert-after-reference, descending-id
 *                            tie-break, tombstones, causal buffering, state-vector sync).
 *   - {@link Awareness}    — ephemeral cursors/presence (relative positions, LWW, TTL).
 *   - {@link createAgentPeer} — the agent as a server-side co-editing replica.
 *   - {@link validateClientOps} — the trusted-relay op validator (anti-forgery + caps).
 *
 * The geneWeave app layers a SQL store + relay + live broadcast on top.
 */
export {
  RgaDoc,
  idGreater,
  idEqual,
  idKey,
  opIdOf,
  type RgaId,
  type RgaOp,
  type StateVector,
  type RgaSnapshot,
} from './rga.js';

export {
  Awareness,
  cursorFromIndex,
  indexFromCursor,
  type RelativePosition,
  type AwarenessState,
  type AwarenessEntry,
  type AwarenessOptions,
} from './awareness.js';

export {
  createAgentPeer,
  agentSiteId,
  isAgentSite,
  AGENT_SITE_PREFIX,
  type AgentPeer,
  type AgentPeerOptions,
} from './agent-peer.js';

export {
  validateClientOps,
  siteOwnedBy,
  type OpValidationOptions,
  type OpValidationResult,
} from './validation.js';
