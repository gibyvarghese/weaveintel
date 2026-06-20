/**
 * Phase 7 — Durable checkpointing for live-agent handlers.
 *
 * `LiveAgentCheckpointStore` is a thin KV-backed store that records the last
 * completed tick index and an opaque state blob for each agent. Handlers opt
 * in via `config_json.checkpoint: true`; the `agentic.react` handler wraps
 * its inner `weaveLiveAgent` call to save state after each tick and to log
 * the resume point at the start of the next one.
 *
 * Two implementations are provided:
 *   - `createDurableLiveAgentCheckpointStore(kv)` — backed by the runtime's
 *     `RuntimeKvStore` (usually the Cloudflare KV or SQLite durable slot
 *     from `@weaveintel/persistence`). Use in production.
 *   - `createInMemoryLiveAgentCheckpointStore()` — plain `Map` for tests.
 */

import type { RuntimeKvStore } from '@weaveintel/core';

export interface AgentCheckpointState {
  stepIndex: number;
  state: unknown;
  savedAt: number;
}

export interface LiveAgentCheckpointStore {
  /** Persist the checkpoint after a successful tick. */
  save(agentId: string, stepIndex: number, state: unknown): Promise<void>;
  /** Load the last saved checkpoint, or `null` when none exists. */
  load(agentId: string): Promise<AgentCheckpointState | null>;
  /** Remove the checkpoint (e.g. when the agent completes its goal). */
  clear(agentId: string): Promise<void>;
}

const PREFIX = 'checkpoint:';

export function createDurableLiveAgentCheckpointStore(kv: RuntimeKvStore): LiveAgentCheckpointStore {
  return {
    async save(agentId, stepIndex, state) {
      const payload: AgentCheckpointState = { stepIndex, state, savedAt: Date.now() };
      await kv.set(`${PREFIX}${agentId}`, JSON.stringify(payload));
    },

    async load(agentId) {
      const raw = await kv.get(`${PREFIX}${agentId}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as AgentCheckpointState;
      } catch {
        return null;
      }
    },

    async clear(agentId) {
      await kv.delete(`${PREFIX}${agentId}`);
    },
  };
}

export function createInMemoryLiveAgentCheckpointStore(): LiveAgentCheckpointStore {
  const store = new Map<string, AgentCheckpointState>();
  return {
    async save(agentId, stepIndex, state) {
      store.set(agentId, { stepIndex, state, savedAt: Date.now() });
    },
    async load(agentId) {
      return store.get(agentId) ?? null;
    },
    async clear(agentId) {
      store.delete(agentId);
    },
  };
}
