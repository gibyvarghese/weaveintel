import type {
  CompressionArtefact,
  CompressionInput,
  ContextCompressor,
  ExecutionContext,
  WorkingMemory,
  WorkingMemoryPatch,
  WorkingMemorySnapshot,
} from '@weaveintel/core';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function applyPatch(current: Record<string, unknown>, patch: WorkingMemoryPatch): Record<string, unknown> {
  if (patch.op === 'set') {
    return { ...current, [patch.key]: patch.value };
  }
  if (patch.op === 'delete') {
    const next = { ...current };
    delete next[patch.key];
    return next;
  }
  return { ...current, ...patch.value };
}

export function weaveWorkingMemory(): WorkingMemory {
  const latestByAgent = new Map<string, WorkingMemorySnapshot>();
  const snapshotsById = new Map<string, WorkingMemorySnapshot>();

  return {
    async patch(
      _ctx: ExecutionContext,
      agentId: string,
      operations: readonly WorkingMemoryPatch[],
      metadata?: Record<string, unknown>,
    ): Promise<WorkingMemorySnapshot> {
      const baseline = latestByAgent.get(agentId);
      const nextState = operations.reduce(
        (acc, operation) => applyPatch(acc, operation),
        { ...(baseline?.content ?? {}) },
      );

      const snapshot: WorkingMemorySnapshot = {
        id: makeId('wm'),
        agentId,
        content: nextState,
        createdAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      };

      latestByAgent.set(agentId, snapshot);
      snapshotsById.set(snapshot.id, snapshot);
      return snapshot;
    },

    async checkpoint(
      _ctx: ExecutionContext,
      agentId: string,
      metadata?: Record<string, unknown>,
    ): Promise<WorkingMemorySnapshot> {
      const current = latestByAgent.get(agentId);
      const snapshot: WorkingMemorySnapshot = {
        id: makeId('wmc'),
        agentId,
        content: { ...(current?.content ?? {}) },
        createdAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      };

      latestByAgent.set(agentId, snapshot);
      snapshotsById.set(snapshot.id, snapshot);
      return snapshot;
    },

    async restore(_ctx: ExecutionContext, agentId: string, snapshotId: string): Promise<WorkingMemorySnapshot | null> {
      const snapshot = snapshotsById.get(snapshotId);
      if (!snapshot || snapshot.agentId !== agentId) {
        return null;
      }
      const restored: WorkingMemorySnapshot = {
        ...snapshot,
        id: makeId('wmr'),
        createdAt: new Date().toISOString(),
      };
      latestByAgent.set(agentId, restored);
      snapshotsById.set(restored.id, restored);
      return restored;
    },

    async getCurrent(_ctx: ExecutionContext, agentId: string): Promise<WorkingMemorySnapshot | null> {
      return latestByAgent.get(agentId) ?? null;
    },
  };
}

export interface CompressorRegistry {
  register(compressor: ContextCompressor): void;
  get(id: string): ContextCompressor | undefined;
  list(): ContextCompressor[];
}

export function createCompressorRegistry(initial?: readonly ContextCompressor[]): CompressorRegistry {
  const map = new Map<string, ContextCompressor>();
  for (const compressor of initial ?? []) {
    map.set(compressor.id, compressor);
  }

  return {
    register(compressor) {
      map.set(compressor.id, compressor);
    },
    get(id) {
      return map.get(id);
    },
    list() {
      return [...map.values()];
    },
  };
}

export function createNoopCompressor(id = 'noop', name = 'Noop Compressor'): ContextCompressor {
  return {
    id,
    name,
    describe() {
      return 'Pass-through compressor for Phase 1 scaffolding.';
    },
    async compress(input: CompressionInput): Promise<CompressionArtefact> {
      const summary = input.messages.map((message) => message.content).join('\n').slice(0, 2000);
      return {
        id: makeId('ca'),
        compressorId: id,
        agentId: input.agentId,
        summary,
        tokensEstimated: Math.ceil(summary.length / 4),
        sourceRefs: input.messages.map((message) => message.id),
        createdAt: new Date().toISOString(),
      };
    },
    async render(artefacts: readonly CompressionArtefact[], tokenBudget: number): Promise<string> {
      const text = artefacts.map((artefact) => artefact.summary).join('\n\n');
      if (text.length <= tokenBudget * 4) {
        return text;
      }
      return text.slice(0, tokenBudget * 4);
    },
  };
}
