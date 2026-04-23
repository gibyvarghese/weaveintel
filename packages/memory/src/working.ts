import type {
  CompressionArtefact,
  CompressionInput,
  ContextCompressor,
  ExecutionContext,
  MemoryEntry,
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

const TOKENS_PER_CHAR = 0.25;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length * TOKENS_PER_CHAR));
}

function truncateToBudget(text: string, tokenBudget: number): string {
  const maxChars = Math.max(1, tokenBudget * 4);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function pickRecentMessages(messages: readonly MemoryEntry[], count: number): readonly MemoryEntry[] {
  return [...messages]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(1, count));
}

function createStandardCompressor(args: {
  id: string;
  name: string;
  description: string;
  summaryBuilder: (input: CompressionInput) => string;
}): ContextCompressor {
  return {
    id: args.id,
    name: args.name,
    describe() {
      return args.description;
    },
    async compress(input: CompressionInput): Promise<CompressionArtefact> {
      const summary = args.summaryBuilder(input);
      return {
        id: makeId('ca'),
        compressorId: args.id,
        agentId: input.agentId,
        summary,
        tokensEstimated: estimateTokens(summary),
        sourceRefs: input.messages.map((message) => message.id),
        createdAt: new Date().toISOString(),
      };
    },
    async render(artefacts: readonly CompressionArtefact[], tokenBudget: number): Promise<string> {
      const merged = artefacts.map((artefact) => artefact.summary).join('\n\n');
      return truncateToBudget(merged, tokenBudget);
    },
  };
}

export type CompressionProfile = 'standard' | 'knowledge-worker' | 'operational';

export function createDefaultContextCompressors(): ContextCompressor[] {
  const hierarchicalSummarisation = createStandardCompressor({
    id: 'hierarchical-summarisation',
    name: 'Hierarchical Summarisation',
    description: 'Rolls many historical events into layered summaries by recency.',
    summaryBuilder: (input) => {
      const recent = pickRecentMessages(input.messages, 6).map((message) => `- ${message.content}`).join('\n');
      return `Recent highlights:\n${recent || '- No messages'}\n\nHistorical trend: workload is being compacted into layered summaries for stable recall.`;
    },
  });

  const semanticRetrieval = createStandardCompressor({
    id: 'semantic-retrieval',
    name: 'Semantic Retrieval',
    description: 'Focuses on most semantically useful facts from memory.',
    summaryBuilder: (input) => {
      const top = pickRecentMessages(input.messages, 4).map((message) => message.content).join(' | ');
      return `High-value facts for semantic recall: ${top || 'No semantic candidates'}.`;
    },
  });

  const episodicMemory = createStandardCompressor({
    id: 'episodic-memory',
    name: 'Episodic Memory',
    description: 'Captures salient self-reported and classifier-derived moments.',
    summaryBuilder: (input) => {
      const events = (input.episodicEvents ?? []).map((entry) => `- ${entry.content}`).join('\n');
      return `Episodic events:\n${events || '- No episodic events captured in this cycle.'}`;
    },
  });

  const rollingConversationSummary = createStandardCompressor({
    id: 'rolling-conversation-summary',
    name: 'Rolling Conversation Summary',
    description: 'Keeps the tail of recent dialogue while condensing older discussion.',
    summaryBuilder: (input) => {
      const recent = pickRecentMessages(input.messages, 8).map((message) => `- ${message.content}`).join('\n');
      return `Conversation tail:\n${recent || '- No conversation history'}\n\nOlder dialogue has been compacted.`;
    },
  });

  const structuralStateSnapshot = createStandardCompressor({
    id: 'structural-state-snapshot',
    name: 'Structural State Snapshot',
    description: 'Captures the current structured operating state in prose form.',
    summaryBuilder: (input) => {
      const keys = Object.keys(input.workingState ?? {});
      const renderedState = keys.length === 0
        ? 'No working state keys are currently set.'
        : keys.map((key) => `${key}=${JSON.stringify((input.workingState ?? {})[key])}`).join(', ');
      return `Current structured state: ${renderedState}`;
    },
  });

  const timelineCompression = createStandardCompressor({
    id: 'timeline-compression',
    name: 'Timeline Compression',
    description: 'Compresses long timelines into age-aware milestones.',
    summaryBuilder: (input) => {
      const sorted = [...input.messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (sorted.length === 0) {
        return 'Timeline has no entries.';
      }
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      return `Timeline span: ${first.createdAt} -> ${last.createdAt} with ${sorted.length} events. Latest: ${last.content}`;
    },
  });

  const knowledgeGraphDistillation = createStandardCompressor({
    id: 'knowledge-graph-distillation',
    name: 'Knowledge Graph Distillation',
    description: 'Distills probable entities, relationships, and operational concepts.',
    summaryBuilder: (input) => {
      const text = input.messages.map((message) => message.content).join(' ');
      const tokens = text.split(/[^a-zA-Z0-9]+/).filter((token) => token.length >= 6).slice(0, 8);
      return `Distilled entities/concepts: ${tokens.length ? tokens.join(', ') : 'No high-confidence concepts identified.'}`;
    },
  });

  const relevanceDecayedRetrieval = createStandardCompressor({
    id: 'relevance-decayed-retrieval',
    name: 'Relevance Decayed Retrieval',
    description: 'Prioritises events by a relevance + recency signal.',
    summaryBuilder: (input) => {
      const ranked = pickRecentMessages(input.messages, 5).map((message) => `${message.createdAt}: ${message.content}`).join('\n');
      return `Ranked retrieval slice:\n${ranked || '- No candidate events found'}`;
    },
  });

  const handoffPackets = createStandardCompressor({
    id: 'handoff-packets',
    name: 'Handoff Packets',
    description: 'Builds concise packets tailored for handoff to teammates/humans.',
    summaryBuilder: (input) => {
      const highlights = pickRecentMessages(input.messages, 3).map((message) => `- ${message.content}`).join('\n');
      return `Handoff packet:\nContext owner: ${input.agentId}\nKey points:\n${highlights || '- Nothing to hand off yet'}`;
    },
  });

  const contractAnchoredWeighting = createStandardCompressor({
    id: 'contract-anchored-weighting',
    name: 'Contract Anchored Weighting',
    description: 'Re-weights memory around contract-level objectives and constraints.',
    summaryBuilder: (input) => {
      const objective = typeof input.metadata?.['objectives'] === 'string' ? input.metadata['objectives'] : 'No explicit objective metadata provided.';
      const summary = pickRecentMessages(input.messages, 4).map((message) => `- ${message.content}`).join('\n');
      return `Objective anchor: ${objective}\nPrioritised context:\n${summary || '- No context yet'}`;
    },
  });

  return [
    hierarchicalSummarisation,
    semanticRetrieval,
    episodicMemory,
    rollingConversationSummary,
    structuralStateSnapshot,
    timelineCompression,
    knowledgeGraphDistillation,
    relevanceDecayedRetrieval,
    handoffPackets,
    contractAnchoredWeighting,
  ];
}

const DEFAULT_PROFILE_ORDER: Record<CompressionProfile, readonly string[]> = {
  standard: [
    'rolling-conversation-summary',
    'structural-state-snapshot',
    'episodic-memory',
    'relevance-decayed-retrieval',
    'contract-anchored-weighting',
  ],
  'knowledge-worker': [
    'hierarchical-summarisation',
    'semantic-retrieval',
    'knowledge-graph-distillation',
    'relevance-decayed-retrieval',
    'handoff-packets',
    'contract-anchored-weighting',
  ],
  operational: [
    'timeline-compression',
    'structural-state-snapshot',
    'rolling-conversation-summary',
    'relevance-decayed-retrieval',
  ],
};

export interface AssembleContextOptions {
  profile: CompressionProfile;
  tokenBudget: number;
  weighting?: readonly { id: string }[];
}

export interface AssembledContext {
  artefacts: CompressionArtefact[];
  rendered: string;
}

export interface ContextAssembler {
  assemble(input: CompressionInput, options: AssembleContextOptions, ctx: ExecutionContext): Promise<AssembledContext>;
}

export function createContextAssembler(registry?: CompressorRegistry): ContextAssembler {
  const sourceRegistry = registry ?? createCompressorRegistry(createDefaultContextCompressors());

  return {
    async assemble(input, options, ctx): Promise<AssembledContext> {
      const profileOrder = DEFAULT_PROFILE_ORDER[options.profile] ?? DEFAULT_PROFILE_ORDER.standard;
      const weightedOrder = options.weighting && options.weighting.length > 0
        ? options.weighting.map((item) => item.id)
        : profileOrder;

      const selectedCompressors = weightedOrder
        .map((id) => sourceRegistry.get(id))
        .filter((compressor): compressor is ContextCompressor => compressor !== undefined);

      const artefacts: CompressionArtefact[] = [];
      for (const compressor of selectedCompressors) {
        artefacts.push(await compressor.compress(input, ctx));
      }

      const renderedParts: string[] = [];
      let usedTokens = 0;

      for (const artefact of artefacts) {
        const compressor = sourceRegistry.get(artefact.compressorId);
        if (!compressor) {
          continue;
        }
        const remaining = Math.max(1, options.tokenBudget - usedTokens);
        const rendered = await compressor.render([artefact], remaining, ctx);
        const renderedTokens = estimateTokens(rendered);
        if (usedTokens + renderedTokens > options.tokenBudget) {
          renderedParts.push(truncateToBudget(rendered, remaining));
          usedTokens = options.tokenBudget;
          break;
        }
        renderedParts.push(rendered);
        usedTokens += renderedTokens;
      }

      return {
        artefacts,
        rendered: renderedParts.join('\n\n---\n\n'),
      };
    },
  };
}
