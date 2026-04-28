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
