import { newUUIDv7 } from '@weaveintel/core';
import type { ExecutionContext, Model, ModelRequest } from '@weaveintel/core';
import { runHybridMemoryExtraction, weaveGovernancePolicy, type ExtractedEntity, type MemoryExtractionRule, type GovernanceRule } from '@weaveintel/memory';
import type { DatabaseAdapter } from './db.js';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import { getActiveSemanticMemoryBackend } from './memory-pgvector.js';

// Local JSON parse helper (mirrors chat.ts safeParseJson, kept internal to this module)
function safeParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadExtractionRules(db: DatabaseAdapter): Promise<MemoryExtractionRule[]> {
  const rows = await db.listMemoryExtractionRules();
  return rows.map((r) => {
    let factsTemplate: Record<string, unknown> | null = null;
    try {
      factsTemplate = r.facts_template ? JSON.parse(r.facts_template) as Record<string, unknown> : null;
    } catch {
      factsTemplate = null;
    }
    return {
      id: r.id,
      ruleType: r.rule_type as MemoryExtractionRule['ruleType'],
      entityType: r.entity_type,
      pattern: r.pattern,
      flags: r.flags,
      factsTemplate,
      priority: r.priority,
      enabled: !!r.enabled,
    };
  });
}

function sanitizeExtractedEntities(raw: unknown): Array<{ name: string; type: string; facts: Record<string, unknown> }> {
  if (!Array.isArray(raw)) return [];
  const allowedTypes = new Set(['person', 'location', 'organization', 'preference', 'topic', 'general']);
  const out: Array<{ name: string; type: string; facts: Record<string, unknown> }> = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { name?: unknown; type?: unknown; facts?: unknown };
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name || name.length > 120) continue;
    const typeRaw = typeof row.type === 'string' ? row.type.toLowerCase().trim() : 'general';
    const type = allowedTypes.has(typeRaw) ? typeRaw : 'general';
    const facts = (row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts))
      ? (row.facts as Record<string, unknown>)
      : {};
    out.push({ name, type, facts });
  }
  return out;
}

export async function extractEntitiesWithModel(
  ctx: ExecutionContext,
  model: Model,
  userContent: string,
  assistantContent: string,
): Promise<ExtractedEntity[]> {
  const request: ModelRequest = {
    messages: [
      {
        role: 'system',
        content: [
          'You extract durable user profile entities from a conversation turn.',
          'Think carefully about stable facts, but output JSON only.',
          'Return a JSON array, each item as: {"name": string, "type": "person|location|organization|preference|topic|general", "facts": object}.',
          'Only include entities that are explicitly stated or strongly implied by the user.',
          'Do not include temporary tasks or speculative details.',
          'If nothing durable is present, return [].',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `User message: ${userContent}`,
          `Assistant response: ${assistantContent.slice(0, 600)}`,
          'Return JSON array only.',
        ].join('\n\n'),
      },
    ],
    maxTokens: 500,
    temperature: 0,
  };
  const res = await model.generate(ctx, request);
  const parsed = safeParseJson(res.content);
  return sanitizeExtractedEntities(parsed).map((e) => ({
    ...e,
    confidence: 0.78,
    source: 'llm' as const,
  }));
}

export async function classifyIdentityRecallIntent(
  ctx: ExecutionContext,
  model: Model,
  query: string,
): Promise<boolean> {
  const regexSignal = /\b(name|who\s+am\s+i|who\s+i\s+am|what\s+am\s+i\s+called|what'?s\s+my\s+name|remember\s+my\s+name|do\s+you\s+know\s+who\s+i\s+am)\b/i.test(query);
  if (regexSignal) return true;

  // Avoid model classification for long prompts where identity intent is unlikely.
  if (query.length > 180) return false;

  try {
    const request: ModelRequest = {
      messages: [
        {
          role: 'system',
          content: [
            'Classify whether the user is asking the assistant to recall who the user is based on prior memory.',
            'Return ONLY one token: YES or NO.',
            'Use YES for questions about identity, name, personal profile, or remembered user details from prior chats.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: query,
        },
      ],
      maxTokens: 3,
      temperature: 0,
    };
    const res = await model.generate(ctx, request);
    return /^\s*yes\b/i.test(res.content);
  } catch {
    return false;
  }
}

export function isIdentityRecallQuery(query: string): boolean {
  return /\b(do\s+you\s+know\s+who\s+i\s+am|who\s+am\s+i|who\s+i\s+am|do\s+you\s+remember\s+me|do\s+you\s+know\s+my\s+name|what(?:'|\s+)?s\s+my\s+name|remember\s+my\s+name)\b/i.test(query);
}

export async function resolveIdentityRecallFromMemory(
  db: DatabaseAdapter,
  userId: string,
  query: string,
): Promise<string | null> {
  if (!isIdentityRecallQuery(query)) return null;

  const backend = getActiveSemanticMemoryBackend();
  const [entities, semanticRows] = await Promise.all([
    db.listEntities(userId),
    backend ? backend.list(userId, 24) : db.listSemanticMemory(userId, 24),
  ]);

  let name: string | null = null;
  let location: string | null = null;

  const personEntity = entities.find((e) => e.entity_type.toLowerCase() === 'person');
  if (personEntity?.entity_name) {
    name = personEntity.entity_name.trim();
  }
  const locationEntity = entities.find((e) => e.entity_type.toLowerCase() === 'location');
  if (locationEntity?.entity_name) {
    location = locationEntity.entity_name.trim();
  }

  const semanticPriority = semanticRows
    .filter((m) => m.memory_type === 'user_fact' || m.source === 'user')
    .concat(semanticRows.filter((m) => !(m.memory_type === 'user_fact' || m.source === 'user')));

  for (const m of semanticPriority) {
    if (!name) {
      const nm = m.content.match(/\b(?:my\s+name\s+is|i\s+am|i'?m\s+called|call\s+me)\s+([A-Za-z][A-Za-z\-']{1,39})\b/i);
      if (nm?.[1]) name = nm[1].trim();
    }
    if (!location) {
      const lm = m.content.match(/\b(?:i\s+live\s+in|i'?m\s+from|i\s+am\s+from|i\s+reside\s+in)\s+([A-Za-z][A-Za-z\s\-']{1,50}?)(?=\s+(?:and|but)\b|[,.!?]|$)/i);
      if (lm?.[1]) location = lm[1].trim();
    }
    if (name && location) break;
  }

  if (name && location) {
    return `From our previous chats, you are ${name} and you live in ${location}.`;
  }
  if (name) {
    return `From our previous chats, you are ${name}.`;
  }
  if (location) {
    return `From our previous chats, I remember that you live in ${location}.`;
  }
  return null;
}

export async function buildMemoryContext(
  db: DatabaseAdapter,
  ctx: ExecutionContext,
  model: Model,
  userId: string,
  query: string,
): Promise<string | null> {
  try {
    const identityQuery = await classifyIdentityRecallIntent(ctx, model, query);
    const entityPromise = identityQuery
      ? db.listEntities(userId).then((rows) => rows.slice(0, 10))
      : db.searchEntities(userId, query);
    // Generate a query embedding for vector-aware semantic search when available
    const embeddingModel = getActiveGuardrailEmbeddingModel();
    let queryEmbedding: number[] | undefined;
    if (embeddingModel) {
      try {
        const res = await embeddingModel.embed(ctx, { input: [query.slice(0, 2000)] });
        queryEmbedding = res.embeddings[0] as number[] | undefined;
      } catch { /* fallback to keyword search */ }
    }

    const memoryBackend = getActiveSemanticMemoryBackend();
    const semanticSearchP = memoryBackend
      ? memoryBackend.search(ctx, { userId, query, limit: 5, queryEmbedding })
      : db.searchSemanticMemory({ userId, query, limit: 5, queryEmbedding });
    const recentSemanticP = identityQuery
      ? (memoryBackend ? memoryBackend.list(userId, 12) : db.listSemanticMemory(userId, 12))
      : Promise.resolve([] as Array<{ content: string; memory_type: string; source: string }>);

    const [semanticMatches, entityMatches, recentSemantic] = await Promise.all([
      semanticSearchP,
      entityPromise,
      recentSemanticP,
    ]);

    const semanticForContext = semanticMatches.length > 0
      ? semanticMatches
      : (identityQuery
        ? recentSemantic.filter((m) => m.memory_type === 'user_fact' || m.source === 'user').slice(0, 5)
        : []);

    if (semanticForContext.length === 0 && entityMatches.length === 0) return null;
    const parts: string[] = ['[Long-term memory from past conversations]'];

    let inferredIdentityName: string | null = null;
    if (identityQuery) {
      const person = entityMatches.find((e) => e.entity_type.toLowerCase() === 'person');
      if (person?.entity_name) {
        inferredIdentityName = person.entity_name;
      } else {
        for (const m of semanticForContext) {
          const nameMatch = m.content.match(/\bmy\s+name\s+is\s+([A-Za-z][A-Za-z\-']{1,39})\b/i);
          if (nameMatch?.[1]) {
            inferredIdentityName = nameMatch[1];
            break;
          }
        }
      }
    }

    if (identityQuery) {
      parts.push('Identity recall request detected. Use these memories to identify the user when possible.');
      parts.push('If a name or identity fact is present below, answer directly from memory and do not claim you lack memory.');
      if (inferredIdentityName) {
        parts.push(`Most likely user name from memory: "${inferredIdentityName}".`);
      }
    }
    if (entityMatches.length > 0) {
      parts.push('Known facts about this user:');
      for (const e of entityMatches) {
        const factsObj = JSON.parse(e.facts) as Record<string, unknown>;
        const factsStr = Object.entries(factsObj)
          .filter(([k]) => !k.startsWith('noted_'))
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        parts.push(`  • ${e.entity_type} "${e.entity_name}"${factsStr ? ' — ' + factsStr : ''}`);
      }
    }
    if (semanticForContext.length > 0) {
      parts.push('Relevant memories:');
      for (const m of semanticForContext) {
        const label = m.source === 'user' ? 'User stated' : 'Previously discussed';
        parts.push(`  • [${label}] ${m.content.slice(0, 200)}`);
      }
    }
    return parts.join('\n');
  } catch {
    return null;
  }
}

/** Convert MemoryGovernanceRow fields to the GovernanceRule expected by weaveGovernancePolicy. */
function toGovernanceRules(rows: Awaited<ReturnType<DatabaseAdapter['listMemoryGovernance']>>): GovernanceRule[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    types: r.memory_types ? tryParseJson<string[]>(r.memory_types) ?? undefined : undefined,
    tenantId: r.tenant_id ?? undefined,
    blockPatterns: r.block_patterns ? tryParseJson<string[]>(r.block_patterns) ?? undefined : undefined,
    redactPatterns: r.redact_patterns ? tryParseJson<string[]>(r.redact_patterns) ?? undefined : undefined,
    maxAge: r.max_age ?? undefined,
    maxEntries: r.max_entries ?? undefined,
    enabled: r.enabled === 1,
  }));
}

function tryParseJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

/** Parse ISO 8601 duration (e.g. P180D) to milliseconds. Returns undefined if unparseable. */
function parseIsoDurationMs(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  const match = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(duration);
  if (!match) return undefined;
  const years = Number(match[1] ?? 0);
  const months = Number(match[2] ?? 0);
  const days = Number(match[3] ?? 0);
  const hours = Number(match[4] ?? 0);
  const minutes = Number(match[5] ?? 0);
  const seconds = Number(match[6] ?? 0);
  return (
    years * 365.25 * 24 * 3600 * 1000 +
    months * 30.437 * 24 * 3600 * 1000 +
    days * 24 * 3600 * 1000 +
    hours * 3600 * 1000 +
    minutes * 60 * 1000 +
    seconds * 1000
  );
}

export async function saveToMemory(
  db: DatabaseAdapter,
  ctx: ExecutionContext,
  model: Model,
  userId: string,
  chatId: string,
  userContent: string,
  assistantContent: string,
): Promise<void> {
  const memBackend = getActiveSemanticMemoryBackend();

  // ── Load extraction rules and governance policy ──────────────────────────
  const [rules, govRows] = await Promise.all([
    loadExtractionRules(db),
    db.listMemoryGovernance(),
  ]);

  const govRules = toGovernanceRules(govRows);
  const policy = weaveGovernancePolicy(govRules);

  const extraction = await runHybridMemoryExtraction({
    ctx,
    input: { userContent, assistantContent },
    rules,
    llmExtractor: async (innerCtx, input) =>
      extractEntitiesWithModel(innerCtx, model, input.userContent, input.assistantContent ?? ''),
  });

  // ── Embedding model — optional, may not be configured ───────────────────
  const embeddingModel = getActiveGuardrailEmbeddingModel();

  async function genEmbedding(text: string): Promise<number[] | undefined> {
    if (!embeddingModel) return undefined;
    try {
      const res = await embeddingModel.embed(ctx, { input: [text.slice(0, 2000)] });
      return res.embeddings[0] as number[] | undefined;
    } catch {
      return undefined;
    }
  }

  // ── Save semantic memories with governance gating ────────────────────────
  // MemoryEntry.type must be a core MemoryType; governance rules seeded with
  // null memory_types (global) will match regardless of type value.
  if (extraction.selfDisclosure && userContent.length > 5) {
    const rawContent = userContent.slice(0, 600);
    const entryId = newUUIDv7();
    const govEntry = { id: entryId, type: 'semantic' as const, content: rawContent, metadata: {}, createdAt: new Date().toISOString(), userId };
    const allowed = await policy.shouldStore(ctx, govEntry);
    if (allowed) {
      const finalContent = policy.beforeStore
        ? (await policy.beforeStore(ctx, govEntry)).content
        : rawContent;
      const embedding = await genEmbedding(finalContent);
      const saveOpts = { id: entryId, userId, chatId, content: finalContent, memoryType: 'user_fact', source: 'user', embedding };
      await (memBackend ? memBackend.save(ctx, saveOpts) : db.saveSemanticMemory(saveOpts));
    }
  }
  if (assistantContent.length > 100) {
    const rawContent = assistantContent.slice(0, 600);
    const entryId = newUUIDv7();
    const govEntry = { id: entryId, type: 'episodic' as const, content: rawContent, metadata: {}, createdAt: new Date().toISOString(), userId };
    const allowed = await policy.shouldStore(ctx, govEntry);
    if (allowed) {
      const finalContent = policy.beforeStore
        ? (await policy.beforeStore(ctx, govEntry)).content
        : rawContent;
      const embedding = await genEmbedding(finalContent);
      const saveOpts = { id: entryId, userId, chatId, content: finalContent, memoryType: 'summary', source: 'assistant', embedding };
      await (memBackend ? memBackend.save(ctx, saveOpts) : db.saveSemanticMemory(saveOpts));
    }
  }

  for (const e of extraction.entities) {
    await db.upsertEntity({
      userId,
      entityName: e.name,
      entityType: e.type,
      facts: e.facts,
      confidence: e.confidence,
      source: e.source,
      chatId,
    });
  }

  const regexEntitiesCount = extraction.entities.filter((e) => e.source === 'regex').length;
  const llmEntitiesCount = extraction.entities.filter((e) => e.source === 'llm').length;
  await db.recordMemoryExtractionEvent({
    id: newUUIDv7(),
    userId,
    chatId,
    selfDisclosure: extraction.selfDisclosure,
    regexEntitiesCount,
    llmEntitiesCount,
    mergedEntitiesCount: extraction.entities.length,
    events: JSON.stringify(extraction.events),
  });

  // ── Enforce retention limits (async, non-blocking on errors) ─────────────
  const retentionPolicy = policy.retentionPolicy;
  if (retentionPolicy) {
    try {
      if (retentionPolicy.maxEntries) {
        await db.trimSemanticMemoryForUser(userId, retentionPolicy.maxEntries);
        await db.trimEntityMemoryForUser(userId, retentionPolicy.maxEntries);
      }
      if (retentionPolicy.maxAge) {
        const cutoffMs = parseIsoDurationMs(retentionPolicy.maxAge);
        if (cutoffMs !== undefined) {
          const cutoff = Date.now() - cutoffMs;
          await db.purgeSemanticMemoryOlderThan(userId, cutoff);
        }
      }
    } catch { /* retention enforcement is best-effort */ }
  }
}
