/**
 * @weaveintel/prompts — Prompt template engine
 *
 * Compiles and renders prompt templates with {{variable}} substitution.
 * Supports default values, type coercion, and missing-variable detection.
 */

import type { PromptTemplate, PromptVariable } from '@weaveintel/core';

// ─── Variable pattern ────────────────────────────────────────

const VAR_RE = /\{\{(\w+)\}\}/g;

// ─── Template implementation ─────────────────────────────────

class WeavePromptTemplate implements PromptTemplate {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly template: string,
    public readonly variables: PromptVariable[],
  ) {}

  render(values: Record<string, unknown>): string {
    const varMap = new Map(this.variables.map(v => [v.name, v]));
    return this.template.replace(VAR_RE, (_match, varName: string) => {
      const spec = varMap.get(varName);
      const raw = values[varName] ?? spec?.defaultValue;
      if (raw === undefined || raw === null) {
        if (spec?.required) throw new Error(`Missing required variable "${varName}"`);
        return '';
      }
      return String(raw);
    });
  }
}

// ─── Factory ─────────────────────────────────────────────────

/**
 * Create a PromptTemplate from a raw template string.
 * Variables are auto-detected from `{{varName}}` placeholders.
 */
export function createTemplate(opts: {
  id?: string;
  name: string;
  template: string;
  variables?: PromptVariable[];
}): PromptTemplate {
  const detectedVars = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(VAR_RE.source, 'g');
  while ((m = re.exec(opts.template)) !== null) detectedVars.add(m[1]!);

  const variables = opts.variables
    ? opts.variables
    : [...detectedVars].map<PromptVariable>(name => ({
        name,
        type: 'string',
        required: true,
      }));

  return new WeavePromptTemplate(
    opts.id ?? `tpl-${Date.now()}`,
    opts.name,
    opts.template,
    variables,
  );
}

/**
 * Extract variable names from a template string.
 */
export function extractVariables(template: string): string[] {
  const vars = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(VAR_RE.source, 'g');
  while ((m = re.exec(template)) !== null) vars.add(m[1]!);
  return [...vars];
}
