import { randomUUID } from 'node:crypto';
import type { ExecutionContext, Model, ModelRequest } from '@weaveintel/core';
import { runHybridMemoryExtraction, type ExtractedEntity, type MemoryExtractionRule } from '@weaveintel/memory';
import type { DatabaseAdapter } from './db.js';

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

  const [entities, semanticRows] = await Promise.all([
    db.listEntities(userId),
    db.listSemanticMemory(userId, 24),
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
    const [semanticMatches, entityMatches, recentSemantic] = await Promise.all([
      db.searchSemanticMemory({ userId, query, limit: 5 }),
      entityPromise,
      identityQuery ? db.listSemanticMemory(userId, 12) : Promise.resolve([]),
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

export async function saveToMemory(
  db: DatabaseAdapter,
  ctx: ExecutionContext,
  model: Model,
  userId: string,
  chatId: string,
  userContent: string,
  assistantContent: string,
): Promise<void> {
  const rules = await loadExtractionRules(db);
  const extraction = await runHybridMemoryExtraction({
    ctx,
    input: { userContent, assistantContent },
    rules,
    llmExtractor: async (innerCtx, input) =>
      extractEntitiesWithModel(innerCtx, model, input.userContent, input.assistantContent ?? ''),
  });

  if (extraction.selfDisclosure && userContent.length > 5) {
    await db.saveSemanticMemory({
      id: randomUUID(),
      userId,
      chatId,
      content: userContent.slice(0, 600),
      memoryType: 'user_fact',
      source: 'user',
    });
  }
  if (assistantContent.length > 100) {
    await db.saveSemanticMemory({
      id: randomUUID(),
      userId,
      chatId,
      content: assistantContent.slice(0, 600),
      memoryType: 'summary',
      source: 'assistant',
    });
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
    id: randomUUID(),
    userId,
    chatId,
    selfDisclosure: extraction.selfDisclosure,
    regexEntitiesCount,
    llmEntitiesCount,
    mergedEntitiesCount: extraction.entities.length,
    events: JSON.stringify(extraction.events),
  });
}
