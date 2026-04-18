/**
 * @weaveintel/prompts — Database record helpers
 *
 * GeneWeave and future apps persist prompts in their own databases. These
 * helpers keep the parsing and normalization logic in the shared prompt layer
 * so app runtimes do not re-implement prompt decoding by hand.
 */

import type {
  PromptDefinition,
  PromptExecutionDefaults,
  PromptKind,
  PromptModelCompatibility,
  PromptStatus,
  PromptVariable,
  PromptVersion,
} from '@weaveintel/core';

export interface PromptRecordLike {
  id: string;
  key?: string | null;
  name: string;
  description?: string | null;
  category?: string | null;
  template?: string | null;
  variables?: string | null;
  version?: string | null;
  status?: string | null;
  prompt_type?: string | null;
  owner?: string | null;
  tags?: string | null;
  model_compatibility?: string | null;
  execution_defaults?: string | null;
  framework?: string | null;
  metadata?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Parse prompt variables from persisted JSON. The helper accepts both the old
 * `string[]` shape and the richer `PromptVariable[]` shape so existing prompt
 * rows remain compatible during the migration.
 */
export function parsePromptVariables(raw: string | null | undefined): PromptVariable[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap<PromptVariable>((item) => {
      if (typeof item === 'string' && item.trim()) {
        return [{ name: item.trim(), type: 'string', required: true }];
      }
      if (!item || typeof item !== 'object') return [];
      const name = typeof (item as Record<string, unknown>)['name'] === 'string'
        ? ((item as Record<string, unknown>)['name'] as string).trim()
        : '';
      if (!name) return [];
      return [{
        name,
        description: typeof (item as Record<string, unknown>)['description'] === 'string'
          ? (item as Record<string, unknown>)['description'] as string
          : undefined,
        type: typeof (item as Record<string, unknown>)['type'] === 'string'
          ? (item as Record<string, unknown>)['type'] as PromptVariable['type']
          : 'string',
        required: typeof (item as Record<string, unknown>)['required'] === 'boolean'
          ? (item as Record<string, unknown>)['required'] as boolean
          : true,
        defaultValue: (item as Record<string, unknown>)['defaultValue'],
      }];
    });
  } catch {
    return [];
  }
}

/**
 * Stringify prompt variables in the richer object form so future versions can
 * retain descriptions, defaults, and type information in the database.
 */
export function stringifyPromptVariables(input: unknown): string | null {
  if (input === undefined || input === null) return null;

  const variables = Array.isArray(input)
    ? input.flatMap<PromptVariable>((item) => {
        if (typeof item === 'string' && item.trim()) {
          return [{ name: item.trim(), type: 'string', required: true }];
        }
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)['name'] === 'string') {
          const name = ((item as Record<string, unknown>)['name'] as string).trim();
          if (!name) return [];
          return [{
            name,
            description: typeof (item as Record<string, unknown>)['description'] === 'string'
              ? (item as Record<string, unknown>)['description'] as string
              : undefined,
            type: typeof (item as Record<string, unknown>)['type'] === 'string'
              ? (item as Record<string, unknown>)['type'] as PromptVariable['type']
              : 'string',
            required: typeof (item as Record<string, unknown>)['required'] === 'boolean'
              ? (item as Record<string, unknown>)['required'] as boolean
              : true,
            defaultValue: (item as Record<string, unknown>)['defaultValue'],
          }];
        }
        return [];
      })
    : [];

  return variables.length > 0 ? JSON.stringify(variables) : null;
}

function parseJsonObject<T>(raw: string | null | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function parseJsonArray(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert an app-specific database row into the shared prompt definition.
 */
export function createPromptDefinitionFromRecord(record: PromptRecordLike): PromptDefinition {
  return {
    id: record.id,
    key: record.key ?? record.id,
    name: record.name,
    description: record.description ?? undefined,
    category: record.category ?? undefined,
    tags: parseJsonArray(record.tags),
    owner: record.owner ? { name: record.owner } : undefined,
    status: (record.status as PromptStatus | null | undefined) ?? 'published',
    kind: (record.prompt_type as PromptKind | null | undefined) ?? 'template',
    currentVersion: record.version ?? '1.0',
    modelCompatibility: parseJsonObject<PromptModelCompatibility>(record.model_compatibility),
    executionDefaults: parseJsonObject<PromptExecutionDefaults>(record.execution_defaults),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

/**
 * Convert an app-specific database row into the shared prompt version. Phase 1
 * maps all persisted prompt rows to text-template prompt versions while keeping
 * the version metadata rich enough for future strategies.
 */
export function createPromptVersionFromRecord(record: PromptRecordLike): PromptVersion {
  const kind = (record.prompt_type as PromptKind | null | undefined) ?? 'template';
  const base = {
    id: record.id,
    promptId: record.key ?? record.id,
    version: record.version ?? '1.0',
    kind,
    status: (record.status as PromptStatus | null | undefined) ?? 'published',
    description: record.description ?? undefined,
    tags: parseJsonArray(record.tags),
    modelCompatibility: parseJsonObject<PromptModelCompatibility>(record.model_compatibility),
    executionDefaults: parseJsonObject<PromptExecutionDefaults>(record.execution_defaults),
    createdAt: record.created_at ?? new Date().toISOString(),
    updatedAt: record.updated_at,
    metadata: parseJsonObject<Record<string, unknown>>(record.metadata),
  };

  if (kind === 'structured') {
    const messages = parseJsonObject<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>>(record.template)
      ?? [{ role: 'system', content: record.template ?? '' }];
    return {
      ...base,
      kind: 'structured',
      messages,
      variables: parsePromptVariables(record.variables),
    };
  }

  return {
    ...base,
    kind: kind === 'template' || kind === 'fewShot' || kind === 'judge' || kind === 'optimizer' || kind === 'modalityPreset'
      ? kind
      : 'template',
    template: record.template ?? '',
    variables: parsePromptVariables(record.variables),
  } as PromptVersion;
}