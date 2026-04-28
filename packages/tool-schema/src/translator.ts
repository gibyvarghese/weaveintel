/**
 * Translator + validator entry points.
 */

import type { ToolDefinition } from '@weaveintel/core';
import type { NormalisedToolCall, ProviderToolAdapter, ValidationIssue } from './types.js';

/** Forward translate canonical tool definitions → provider format. */
export function translate(
  tools: readonly ToolDefinition[],
  adapter: ProviderToolAdapter,
): unknown[] {
  return adapter.translate(tools);
}

/**
 * anyWeave Phase 6 — circuit-breaker wrapper around `translate()`.
 *
 * Tool translation must never block a model request. If an adapter throws
 * (malformed schema, unsupported feature, etc.) we fall back to *no tools*
 * with a structured warning. Repeated failures trip a per-adapter breaker
 * that short-circuits subsequent calls for a cooldown window.
 */
export interface SafeTranslateResult {
  /** Provider-shaped tools array (empty when translation failed or skipped). */
  tools: unknown[];
  /** True if translation succeeded and produced the full tool list. */
  ok: boolean;
  /** Populated when `ok=false`. */
  error?: { message: string; reason: 'adapter_error' | 'breaker_open' };
}

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;
const breakers = new Map<string, BreakerState>();

function getBreaker(adapterId: string): BreakerState {
  let s = breakers.get(adapterId);
  if (!s) { s = { failures: 0, openedAt: null }; breakers.set(adapterId, s); }
  return s;
}

function isBreakerOpen(s: BreakerState): boolean {
  if (s.openedAt === null) return false;
  if (Date.now() - s.openedAt > COOLDOWN_MS) {
    // Half-open — give it another chance.
    s.openedAt = null;
    s.failures = 0;
    return false;
  }
  return true;
}

export function safeTranslate(
  tools: readonly ToolDefinition[],
  adapter: ProviderToolAdapter,
  opts?: { onWarning?: (msg: string) => void },
): SafeTranslateResult {
  const id = adapter.provider;
  const breaker = getBreaker(id);
  if (isBreakerOpen(breaker)) {
    const error = { message: `Tool translator breaker open for ${id} (>=${FAILURE_THRESHOLD} consecutive failures)`, reason: 'breaker_open' as const };
    opts?.onWarning?.(error.message);
    return { tools: [], ok: false, error };
  }
  try {
    const out = adapter.translate(tools);
    breaker.failures = 0;
    breaker.openedAt = null;
    return { tools: out, ok: true };
  } catch (e) {
    breaker.failures += 1;
    if (breaker.failures >= FAILURE_THRESHOLD) breaker.openedAt = Date.now();
    const message = e instanceof Error ? e.message : String(e);
    opts?.onWarning?.(`safeTranslate(${id}) failed: ${message} (failures=${breaker.failures})`);
    return { tools: [], ok: false, error: { message, reason: 'adapter_error' } };
  }
}

/** Test/diagnostic helper — reset all breakers (or a single adapter's). */
export function resetTranslatorBreaker(adapterId?: string): void {
  if (adapterId) breakers.delete(adapterId);
  else breakers.clear();
}

/** Diagnostic — returns a snapshot of breaker state for observability. */
export function getTranslatorBreakerSnapshot(): Array<{ adapterId: string; failures: number; open: boolean; openedAt: number | null }> {
  return Array.from(breakers.entries()).map(([adapterId, s]) => ({
    adapterId,
    failures: s.failures,
    open: s.openedAt !== null,
    openedAt: s.openedAt,
  }));
}

/** Reverse: extract normalised tool calls from a provider response body. */
export function parseToolCall(
  rawResponse: unknown,
  adapter: ProviderToolAdapter,
): readonly NormalisedToolCall[] {
  return adapter.parseToolCall(rawResponse);
}

/**
 * Validate the canonical tool definitions against an adapter's constraints
 * (name regex, max count). Returns issues — empty array means OK.
 */
export function validate(
  tools: readonly ToolDefinition[],
  adapter: ProviderToolAdapter,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (tools.length > adapter.maxToolCount) {
    issues.push({
      toolName: '*',
      code: 'too_many_tools',
      message: `${tools.length} tools exceed adapter limit of ${adapter.maxToolCount}`,
    });
  }
  let re: RegExp;
  try {
    re = new RegExp(adapter.nameValidationRegex);
  } catch {
    re = /^[a-zA-Z0-9_-]{1,64}$/;
  }
  for (const t of tools) {
    if (!re.test(t.name)) {
      issues.push({
        toolName: t.name,
        code: 'name_invalid',
        message: `Tool name "${t.name}" does not match ${adapter.nameValidationRegex}`,
      });
    }
  }
  return issues;
}
