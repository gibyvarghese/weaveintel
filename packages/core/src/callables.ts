/**
 * @weaveintel/core — LLM-callable component metadata contracts
 *
 * Shared across prompts, skills, tools, agents, and workflows so apps can
 * enforce consistent discovery metadata for model-facing components.
 */

export type CallableKind = 'prompt' | 'skill' | 'tool' | 'agent' | 'workflow';

export interface CallableDescriptor {
  id: string;
  name: string;
  kind: CallableKind;
  description: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface CallableDescriptionValidationOptions {
  /** Minimum description length in characters. */
  minLength?: number;
  /** Minimum description length in words. */
  minWords?: number;
}

export interface CallableDescriptionValidationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Normalize a description to stable whitespace before persistence/validation.
 */
export function normalizeCallableDescription(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim().replace(/\s+/g, ' ');
}

/**
 * Validate model-facing descriptions so callables remain discoverable by LLMs.
 */
export function validateCallableDescription(
  description: unknown,
  opts: CallableDescriptionValidationOptions = {},
): CallableDescriptionValidationResult {
  const minLength = opts.minLength ?? 40;
  const minWords = opts.minWords ?? 8;
  const normalized = normalizeCallableDescription(description);
  const reasons: string[] = [];

  if (!normalized) {
    reasons.push('description is required');
  }

  if (normalized.length > 0 && normalized.length < minLength) {
    reasons.push(`description must be at least ${minLength} characters`);
  }

  const words = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
  if (words > 0 && words < minWords) {
    reasons.push(`description must be at least ${minWords} words`);
  }

  return { valid: reasons.length === 0, reasons };
}
