/**
 * @weaveintel/prompts — Phase 5 safe prompt version resolution helpers
 *
 * These helpers centralize deterministic, database-driven prompt version and
 * experiment resolution so applications do not duplicate fallback logic.
 *
 * Design goals:
 * - Deterministic resolution (same input context => same selected variant)
 * - Safe lifecycle handling (prefer published + active versions)
 * - Backward compatibility (falls back to base prompt rows when version tables
 *   are empty during migration)
 */

import type { PromptRecordLike } from './records.js';

/**
 * Persisted prompt version record expected from app-level databases.
 *
 * The shape intentionally mirrors a practical SQL row while remaining runtime
 * agnostic so any app can project its own DB row into this contract.
 */
export interface PromptVersionRecordLike {
  id: string;
  prompt_id: string;
  version: string;
  status?: string | null; // draft | published | retired
  is_active?: number | boolean;
  template?: string | null;
  variables?: string | null;
  model_compatibility?: string | null;
  execution_defaults?: string | null;
  framework?: string | null;
  metadata?: string | null;
  enabled?: number | boolean;
  created_at?: string;
  updated_at?: string;
}

/**
 * Persisted prompt experiment row.
 *
 * variants_json example:
 * [
 *   { "version": "1.0", "weight": 60, "label": "control" },
 *   { "version": "1.1", "weight": 40, "label": "candidate" }
 * ]
 */
export interface PromptExperimentRecordLike {
  id: string;
  prompt_id: string;
  name?: string | null;
  status?: string | null; // draft | active | completed
  variants_json: string;
  enabled?: number | boolean;
  created_at?: string;
  updated_at?: string;
}

export interface PromptExperimentVariant {
  version: string;
  weight: number;
  label?: string;
}

export interface PromptResolutionOptions {
  /** Explicit version override, usually from runtime settings or test harnesses. */
  requestedVersion?: string;
  /** Optional experiment id to force/use; if omitted, first active experiment is used. */
  experimentId?: string;
  /**
   * Stable context key used for deterministic weighted variant assignment.
   * Typical values: tenant id, chat id, or user id.
   */
  assignmentKey?: string;
}

export interface ResolvedPromptRecord {
  record: PromptRecordLike;
  meta: {
    source: 'base_prompt' | 'prompt_version';
    resolvedVersion: string;
    selectedBy: 'requested_version' | 'experiment' | 'active_flag' | 'latest_published' | 'base_prompt';
    experimentId?: string;
    experimentVariantLabel?: string;
  };
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function parseVariants(raw: string): PromptExperimentVariant[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap<PromptExperimentVariant>((item) => {
      if (!item || typeof item !== 'object') return [];
      const rec = item as Record<string, unknown>;
      const version = typeof rec['version'] === 'string' ? rec['version'].trim() : '';
      const weight = Number(rec['weight']);
      if (!version || !Number.isFinite(weight) || weight <= 0) return [];
      return [{
        version,
        weight,
        label: typeof rec['label'] === 'string' ? rec['label'] : undefined,
      }];
    });
  } catch {
    return [];
  }
}

function parseVersionParts(v: string): number[] {
  return v
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function deterministicHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickWeightedVariant(
  variants: PromptExperimentVariant[],
  assignmentKey: string,
): PromptExperimentVariant | null {
  if (variants.length === 0) return null;
  const total = variants.reduce((acc, item) => acc + item.weight, 0);
  if (total <= 0) return null;

  const bucket = deterministicHash(assignmentKey) % total;
  let cursor = 0;
  for (const variant of variants) {
    cursor += variant.weight;
    if (bucket < cursor) return variant;
  }
  return variants[variants.length - 1] ?? null;
}

function materializeRecordFromVersion(
  prompt: PromptRecordLike,
  versionRow: PromptVersionRecordLike,
): PromptRecordLike {
  return {
    ...prompt,
    template: versionRow.template ?? prompt.template,
    variables: versionRow.variables ?? prompt.variables,
    version: versionRow.version,
    status: versionRow.status ?? prompt.status,
    model_compatibility: versionRow.model_compatibility ?? prompt.model_compatibility,
    execution_defaults: versionRow.execution_defaults ?? prompt.execution_defaults,
    framework: versionRow.framework ?? prompt.framework,
    metadata: versionRow.metadata ?? prompt.metadata,
    updated_at: versionRow.updated_at ?? prompt.updated_at,
  };
}

/**
 * Resolve a prompt row into the exact model-facing prompt record that should be
 * rendered at runtime, based on version lifecycle and optional experiments.
 */
export function resolvePromptRecordForExecution(args: {
  prompt: PromptRecordLike;
  versions?: PromptVersionRecordLike[];
  experiments?: PromptExperimentRecordLike[];
  options?: PromptResolutionOptions;
}): ResolvedPromptRecord {
  const prompt = args.prompt;
  const versions = (args.versions ?? [])
    .filter((row) => row.prompt_id === prompt.id)
    .filter((row) => row.version && row.version.trim().length > 0)
    .filter((row) => row.enabled === undefined || isTruthyFlag(row.enabled));
  const options = args.options ?? {};

  // 1) Explicit version override takes precedence.
  if (options.requestedVersion) {
    const requested = versions.find((row) => row.version === options.requestedVersion);
    if (requested) {
      return {
        record: materializeRecordFromVersion(prompt, requested),
        meta: {
          source: 'prompt_version',
          resolvedVersion: requested.version,
          selectedBy: 'requested_version',
        },
      };
    }
  }

  // 2) Active experiment selection (deterministic by assignment key).
  const activeExperiments = (args.experiments ?? [])
    .filter((exp) => exp.prompt_id === prompt.id)
    .filter((exp) => exp.status === 'active')
    .filter((exp) => exp.enabled === undefined || isTruthyFlag(exp.enabled));

  const targetedExperiment = options.experimentId
    ? activeExperiments.find((exp) => exp.id === options.experimentId)
    : activeExperiments[0];

  if (targetedExperiment) {
    const variants = parseVariants(targetedExperiment.variants_json);
    const assignmentKey = options.assignmentKey ?? `${prompt.id}:default`;
    const chosen = pickWeightedVariant(variants, assignmentKey);
    if (chosen) {
      const version = versions.find((row) => row.version === chosen.version);
      if (version) {
        return {
          record: materializeRecordFromVersion(prompt, version),
          meta: {
            source: 'prompt_version',
            resolvedVersion: version.version,
            selectedBy: 'experiment',
            experimentId: targetedExperiment.id,
            experimentVariantLabel: chosen.label,
          },
        };
      }
    }
  }

  // 3) Explicit active flag on published versions.
  const activePublished = versions.find(
    (row) => isTruthyFlag(row.is_active) && (row.status ?? 'published') === 'published',
  );
  if (activePublished) {
    return {
      record: materializeRecordFromVersion(prompt, activePublished),
      meta: {
        source: 'prompt_version',
        resolvedVersion: activePublished.version,
        selectedBy: 'active_flag',
      },
    };
  }

  // 4) Latest published version fallback.
  const latestPublished = versions
    .filter((row) => (row.status ?? 'published') === 'published')
    .sort((a, b) => compareVersions(b.version, a.version))[0];

  if (latestPublished) {
    return {
      record: materializeRecordFromVersion(prompt, latestPublished),
      meta: {
        source: 'prompt_version',
        resolvedVersion: latestPublished.version,
        selectedBy: 'latest_published',
      },
    };
  }

  // 5) Migration-safe fallback to base prompt row.
  return {
    record: prompt,
    meta: {
      source: 'base_prompt',
      resolvedVersion: prompt.version ?? '1.0',
      selectedBy: 'base_prompt',
    },
  };
}
