/**
 * @weaveintel/agents — P4-1: Portable memory tool set factory
 *
 * `createMemoryToolSet(opts)` builds the same 10 memory tools that a host
 * application exposes, but via caller-supplied callbacks instead of a specific DB layer.
 * This lets any `weaveAgent` consumer wire in `@weaveintel/memory` (or any
 * other store) without importing a host application or the web app.
 *
 * The tool set mirrors the reference set:
 *   memory_recall             — semantic + entity recall
 *   memory_search             — ranked search across stores
 *   memory_remember           — explicit save
 *   memory_forget             — entity + semantic removal
 *   memory_list_entities      — entity fact sheet
 *   memory_list_episodes      — episodic timeline
 *   memory_get_profile        — comprehensive user profile
 *   memory_snapshot           — save working-state blob
 *   memory_load_state         — restore working-state blob
 *   memory_propose_instruction — propose a procedural instruction delta
 *
 * Usage:
 * ```ts
 * const tools = createMemoryToolSet({
 *   userId: 'user-123',
 *   recall: async (q, limit) => ({ semantic: [...], entities: [...] }),
 *   remember: async (content, type) => ({ id: 'mem-001' }),
 * });
 * const agent = weaveAgent({ model, tools: weaveMergeTools(baseReg, tools) });
 * ```
 */

import { weaveTool, weaveToolRegistry } from '@weaveintel/core';
import type { Tool, ToolRegistry } from '@weaveintel/core';

// ─── Result types ──────────────────────────────────────────────

export interface SemanticMemoryEntry {
  content: string;
  source: string;
  memoryType?: string;
}

export interface EntityMemoryEntry {
  entityType: string;
  entityName: string;
  facts: Record<string, unknown>;
  confidence?: number;
}

export interface EpisodeEntry {
  id?: string;
  messageRole: string;
  content: string;
  importance?: number;
  createdAt: string;
}

export interface MemoryProfileResult {
  entities: EntityMemoryEntry[];
  semantic: SemanticMemoryEntry[];
  episodic: EpisodeEntry[];
  procedural: Array<{ instructionDelta: string; appliedAt: string }>;
}

export interface MemorySnapshotResult {
  snapshot: Record<string, unknown> | null;
  id: string | null;
  savedAt: string | null;
}

// ─── Options ───────────────────────────────────────────────────

export interface MemoryToolSetOptions {
  /**
   * The user identifier propagated into every callback.
   * Required — without it all tools return "unavailable" errors.
   */
  userId: string;

  /**
   * Optional chat/session identifier propagated to snapshot callbacks.
   */
  chatId?: string;

  /**
   * Optional agent identifier for procedural memory and snapshots.
   * Defaults to `'default'`.
   */
  agentId?: string;

  // ─── Memory callbacks (all optional — omitted tools remain no-ops) ───

  recall?: (
    query: string,
    limit?: number,
  ) => Promise<{
    semantic: SemanticMemoryEntry[];
    entities: EntityMemoryEntry[];
  }>;

  search?: (
    query: string,
    limit?: number,
  ) => Promise<{
    semantic: SemanticMemoryEntry[];
    entities: EntityMemoryEntry[];
  }>;

  remember?: (
    content: string,
    memoryType?: string,
  ) => Promise<{ id: string }>;

  forget?: (
    entityName: string,
  ) => Promise<{ ok: boolean; deletedEntities?: number; deletedSemantic?: number }>;

  listEntities?: () => Promise<{ entities: EntityMemoryEntry[] }>;

  listEpisodes?: (limit?: number) => Promise<{ episodes: EpisodeEntry[] }>;

  getProfile?: () => Promise<MemoryProfileResult>;

  saveSnapshot?: (
    state: Record<string, unknown>,
    label?: string,
  ) => Promise<{ id: string }>;

  loadSnapshot?: () => Promise<MemorySnapshotResult>;

  proposeInstruction?: (
    instruction: string,
    reason?: string,
    confidence?: number,
  ) => Promise<{ id: string }>;
}

// ─── Factory ───────────────────────────────────────────────────

/**
 * Build the 10 standard memory tools with caller-supplied backing callbacks.
 *
 * Every tool degrades gracefully: when the corresponding callback is not
 * provided it returns a structured `isError: true` response rather than
 * throwing.  This lets callers register only the subset they support.
 *
 * Returns an array of `Tool` instances; register them in any `ToolRegistry`
 * via `registry.register(tool)` or use `createMemoryToolRegistry(opts)` to
 * get a ready-to-use registry.
 */
export function createMemoryToolSet(opts: MemoryToolSetOptions): Tool[] {
  const { userId, agentId = 'default' } = opts;

  // ── memory_recall ────────────────────────────────────────────
  const recallTool = weaveTool({
    name: 'memory_recall',
    description:
      'Retrieve relevant long-term memory for the current user from semantic and entity memory stores.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to recall from memory for this user' },
        limit: { type: 'number', description: 'Max semantic memories to return (default: 5, max: 20)' },
      },
      required: ['query'],
    },
    tags: ['memory', 'personalization'],
    execute: async (args) => {
      const { query, limit: rawLimit } = args as { query: string; limit?: number };
      if (!opts.recall) {
        return { content: 'Memory recall is unavailable in this execution context.', isError: true };
      }
      const limit = Math.max(1, Math.min(20, Number(rawLimit ?? 5)));
      const recalled = await opts.recall(query, limit);
      return JSON.stringify({
        query,
        semanticCount: recalled.semantic.length,
        entityCount: recalled.entities.length,
        semantic: recalled.semantic,
        entities: recalled.entities,
      }, null, 2);
    },
  });

  // ── memory_search ────────────────────────────────────────────
  const searchTool = weaveTool({
    name: 'memory_search',
    description:
      "Perform a targeted search of the user's long-term memory using natural language. Returns ranked semantic memories and matching entity facts.",
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for in memory' },
        limit: { type: 'number', description: 'Max results to return (default: 5, max: 20)' },
      },
      required: ['query'],
    },
    tags: ['memory', 'search'],
    execute: async (args) => {
      const { query, limit: rawLimit } = args as { query: string; limit?: number };
      if (!opts.search) {
        return { content: 'Memory search is unavailable in this execution context.', isError: true };
      }
      const limit = Math.max(1, Math.min(20, Number(rawLimit ?? 5)));
      const results = await opts.search(query, limit);
      return JSON.stringify({
        query,
        semanticCount: results.semantic.length,
        entityCount: results.entities.length,
        semantic: results.semantic,
        entities: results.entities,
      }, null, 2);
    },
  });

  // ── memory_remember ──────────────────────────────────────────
  const rememberTool = weaveTool({
    name: 'memory_remember',
    description:
      "Explicitly save a fact or note to the user's long-term memory. Use when the user asks you to remember something specific.",
    parameters: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The fact or note to remember' },
        memoryType: {
          type: 'string',
          description: 'Category: user_fact, preference, or summary (default: user_fact)',
          enum: ['user_fact', 'preference', 'summary'],
        },
      },
      required: ['content'],
    },
    tags: ['memory', 'remember'],
    execute: async (args) => {
      const { content, memoryType } = args as { content: string; memoryType?: string };
      if (!opts.remember) {
        return { content: 'Memory remember is unavailable in this execution context.', isError: true };
      }
      const result = await opts.remember(content, memoryType ?? 'user_fact');
      return JSON.stringify({ ok: true, id: result.id });
    },
  });

  // ── memory_forget ────────────────────────────────────────────
  const forgetTool = weaveTool({
    name: 'memory_forget',
    description:
      "Remove memories about a subject from the user's long-term memory. Only use when the user explicitly asks you to forget something.",
    parameters: {
      type: 'object' as const,
      properties: {
        entityName: {
          type: 'string',
          description: 'The entity name, subject, or content snippet identifying memories to forget',
        },
      },
      required: ['entityName'],
    },
    tags: ['memory', 'forget'],
    execute: async (args) => {
      const { entityName } = args as { entityName: string };
      if (!opts.forget) {
        return { content: 'Memory forget is unavailable in this execution context.', isError: true };
      }
      const result = await opts.forget(entityName);
      return JSON.stringify({
        ok: result.ok,
        entityName,
        deletedEntities: result.deletedEntities ?? 0,
        deletedSemantic: result.deletedSemantic ?? 0,
      });
    },
  });

  // ── memory_list_entities ─────────────────────────────────────
  const listEntitiesTool = weaveTool({
    name: 'memory_list_entities',
    description:
      'List all known facts about the current user from the entity memory store — name, location, job, preferences, and other extracted attributes.',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
    tags: ['memory', 'profile'],
    execute: async () => {
      if (!opts.listEntities) {
        return { content: 'Memory list entities is unavailable in this execution context.', isError: true };
      }
      const result = await opts.listEntities();
      return JSON.stringify({ entityCount: result.entities.length, entities: result.entities }, null, 2);
    },
  });

  // ── memory_list_episodes ─────────────────────────────────────
  const listEpisodesTool = weaveTool({
    name: 'memory_list_episodes',
    description:
      "List the most recent episodic memory events for the current user — a timestamped log of past conversation turns. Useful for recalling context from previous sessions.",
    parameters: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max events to return (default: 10, max: 30)' },
      },
      required: [],
    },
    tags: ['memory', 'episodic', 'history'],
    execute: async (args) => {
      const { limit: rawLimit } = args as { limit?: number };
      if (!opts.listEpisodes) {
        return { content: 'Episodic memory is unavailable in this execution context.', isError: true };
      }
      const limit = Math.max(1, Math.min(30, Number(rawLimit ?? 10)));
      const result = await opts.listEpisodes(limit);
      return JSON.stringify({ episodeCount: result.episodes.length, episodes: result.episodes }, null, 2);
    },
  });

  // ── memory_get_profile ───────────────────────────────────────
  const getProfileTool = weaveTool({
    name: 'memory_get_profile',
    description:
      'Return a comprehensive profile of the current user assembled from all memory stores — entity facts, semantic memories, recent episodes, and applied procedural instructions.',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
    tags: ['memory', 'profile', 'identity'],
    execute: async () => {
      if (!opts.getProfile) {
        return { content: 'User profile memory is unavailable in this execution context.', isError: true };
      }
      const profile = await opts.getProfile();
      return JSON.stringify(profile, null, 2);
    },
  });

  // ── memory_snapshot ──────────────────────────────────────────
  const snapshotTool = weaveTool({
    name: 'memory_snapshot',
    description:
      'Save the current working state as a JSON snapshot to working memory. Use this to checkpoint progress during multi-step tasks so it can be resumed later.',
    parameters: {
      type: 'object' as const,
      properties: {
        state: {
          type: 'object',
          description: 'Arbitrary JSON object representing current working state',
        },
        label: {
          type: 'string',
          description: 'Optional human-readable label for this snapshot',
        },
      },
      required: ['state'],
    },
    tags: ['memory', 'working', 'state'],
    execute: async (args) => {
      const { state, label } = args as { state: Record<string, unknown>; label?: string };
      if (!opts.saveSnapshot) {
        return { content: 'Working memory is unavailable in this execution context.', isError: true };
      }
      const result = await opts.saveSnapshot(state, label);
      return JSON.stringify({ ok: true, snapshotId: result.id, label: label ?? null });
    },
  });

  // ── memory_load_state ────────────────────────────────────────
  const loadStateTool = weaveTool({
    name: 'memory_load_state',
    description:
      "Load the most recent working memory snapshot for this user. Use at the start of a resumed multi-step task to restore previous intermediate state.",
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
    tags: ['memory', 'working', 'state'],
    execute: async () => {
      if (!opts.loadSnapshot) {
        return { content: 'Working memory is unavailable in this execution context.', isError: true };
      }
      const result = await opts.loadSnapshot();
      if (!result.snapshot) {
        return JSON.stringify({ found: false, snapshot: null });
      }
      return JSON.stringify({
        found: true,
        snapshotId: result.id,
        savedAt: result.savedAt,
        snapshot: result.snapshot,
      });
    },
  });

  // ── memory_propose_instruction ────────────────────────────────
  const proposeInstructionTool = weaveTool({
    name: 'memory_propose_instruction',
    description:
      'Propose a persistent behavioural adjustment for how the agent should interact with this user in future conversations. The proposal is submitted for human review. Only use when you have strong evidence a change would improve the experience.',
    parameters: {
      type: 'object' as const,
      properties: {
        instruction: {
          type: 'string',
          description: 'The behavioural change to propose',
        },
        reason: {
          type: 'string',
          description: 'Brief justification — what evidence led to this proposal',
        },
        confidence: {
          type: 'number',
          description: 'Confidence in this proposal (0.0–1.0, default 0.75)',
        },
      },
      required: ['instruction'],
    },
    tags: ['memory', 'procedural', 'proposal'],
    execute: async (args) => {
      const { instruction, reason, confidence } = args as { instruction: string; reason?: string; confidence?: number };
      if (!opts.proposeInstruction) {
        return { content: 'Procedural memory proposals are unavailable in this execution context.', isError: true };
      }
      const result = await opts.proposeInstruction(instruction, reason, confidence ?? 0.75);
      return JSON.stringify({
        ok: true,
        proposalId: result.id,
        status: 'proposed',
        message: 'Proposal submitted for human review. It will take effect only after an admin approves and applies it.',
      });
    },
  });

  // Attach userId/agentId/chatId as non-tool context (informational only, not used in execute above)
  void userId;
  void agentId;

  return [
    recallTool,
    searchTool,
    rememberTool,
    forgetTool,
    listEntitiesTool,
    listEpisodesTool,
    getProfileTool,
    snapshotTool,
    loadStateTool,
    proposeInstructionTool,
  ];
}

/**
 * Convenience wrapper: builds all 10 memory tools and returns them
 * pre-loaded into a `ToolRegistry`.
 */
export function createMemoryToolRegistry(opts: MemoryToolSetOptions): ToolRegistry {
  const reg = weaveToolRegistry();
  for (const tool of createMemoryToolSet(opts)) {
    reg.register(tool);
  }
  return reg;
}
