/**
 * @weaveintel/prompts — Prompt lint/validation module
 *
 * Runs static analysis on prompt templates BEFORE render time to surface
 * problems as typed diagnostic results rather than silent failures or
 * hard crashes at production runtime.
 *
 * WHY: A prompt with a misspelled variable name, a missing required variable,
 * or an unresolved fragment reference silently degrades model output. Lint
 * catches those problems early — during admin creation, in CI, or via the
 * admin UI badge before a prompt is promoted to production.
 *
 * SEVERITIES:
 *   error   – Will cause a render failure or incorrect model output.
 *             Examples: missing required variable, unresolved fragment.
 *   warning – Degrades output quality but does not crash rendering.
 *             Examples: unused variable, missing description, no version bump.
 *   info    – Best-practice guidance. Does not block deployment.
 *             Examples: template longer than recommended, no examples attached.
 *
 * CHECKS PERFORMED:
 *   missing_required_variable   – Template variable marked `required` has no value.
 *   missing_optional_variable   – Template uses `{{var}}` but `var` is not declared.
 *   undefined_variable          – Declared variable has no corresponding `{{var}}` usage.
 *   empty_template              – Template string is empty or whitespace only.
 *   excessive_size              – Template exceeds the recommended character threshold.
 *   unresolved_fragment         – `{{>key}}` references a fragment key not in the registry.
 *   circular_fragment           – Fragment expansion detected a circular include.
 *   missing_description         – Prompt has no description (important for LLM discovery).
 *   no_variables_declared       – Template has interpolation markers but no variable declarations.
 *
 * USAGE:
 *   const results = lintPromptTemplate(template, variables, values, fragmentRegistry);
 *   const errors = results.filter(r => r.severity === 'error');
 *
 * INTEGRATION:
 *   - Admin UI: Show a lint badge (error/warning count) on each prompt card.
 *   - Prompt save: Run lint on create/update; block save on errors (optional).
 *   - CI: Run lintPromptTemplate() in the build pipeline via example 09-eval-suite.ts.
 *   - renderPromptRecord(): Optionally attach lint warnings to the trace span.
 */

import { extractFragmentKeys } from './fragments.js';
import type { FragmentRegistry } from './fragments.js';

// ─── Severity & result types ──────────────────────────────────

/** Severity level for a lint diagnostic. */
export type PromptLintSeverity = 'error' | 'warning' | 'info';

/** Rule identifiers emitted by the linter. */
export type PromptLintRuleId =
  | 'missing_required_variable'
  | 'missing_optional_variable'
  | 'undefined_variable'
  | 'empty_template'
  | 'excessive_size'
  | 'unresolved_fragment'
  | 'circular_fragment'
  | 'missing_description'
  | 'no_variables_declared';

/**
 * A single lint diagnostic produced by lintPromptTemplate().
 * Suitable for display in admin UI, CI output, and trace metadata.
 */
export interface PromptLintResult {
  /** Severity level — determines whether to block save/deploy. */
  severity: PromptLintSeverity;
  /** Machine-readable rule identifier for filtering and metric tracking. */
  rule: PromptLintRuleId;
  /** Human-readable message explaining the issue and how to fix it. */
  message: string;
  /**
   * The variable name or fragment key implicated in the finding.
   * undefined for checks that apply to the template as a whole.
   */
  subject?: string;
}

// ─── Lint context ────────────────────────────────────────────

/**
 * Variable declaration as understood by the linter.
 * Mirrors the PromptVariable shape from @weaveintel/core.
 */
export interface LintVariable {
  name: string;
  required?: boolean;
  defaultValue?: string | null;
  description?: string;
}

/**
 * Optional context passed to lintPromptTemplate() to enable additional checks.
 */
export interface LintContext {
  /** Human-facing description of the prompt. Missing description triggers a warning. */
  description?: string | null;
  /** Fragment registry used to verify `{{>key}}` references exist. */
  fragmentRegistry?: FragmentRegistry;
  /** Character threshold above which the template triggers an `excessive_size` info. */
  excessiveSizeThreshold?: number;
}

// ─── Regex helpers ────────────────────────────────────────────

/**
 * Matches `{{variableName}}` variable interpolations.
 * Capture group 1 = the variable name (no leading `>`).
 */
const VAR_USAGE_RE = /\{\{(?!>)\s*([\w.]+)\s*\}\}/g;

/**
 * Matches `{{>CIRCULAR:key}}` markers left by the fragment resolver
 * when a circular include is detected.
 */
const CIRCULAR_RE = /\{\{>CIRCULAR:([\w.\-]+)\}\}/g;

// ─── Main lint function ────────────────────────────────────────

/**
 * Analyse a prompt template and return a list of typed lint diagnostics.
 *
 * Runs the following checks in sequence:
 *   1. Empty template check
 *   2. Excessive size check
 *   3. Missing description check
 *   4. Fragment reference checks (unresolved, circular)
 *   5. Variable usage vs declaration cross-check
 *   6. Missing required variable value check (against provided values map)
 *
 * @param template         - The raw template string AFTER fragment resolution
 *                           (so unresolved `{{>key}}` markers are visible).
 * @param variables        - Variable declarations on the prompt record.
 * @param values           - Actual variable values that would be supplied at render time.
 *                           Pass an empty object to check for structural issues only.
 * @param context          - Optional context enabling additional checks.
 * @returns Array of PromptLintResult, empty if the template passes all checks.
 *
 * @example
 * const results = lintPromptTemplate(
 *   'You are {{role}}. Complete {{task}}.',
 *   [{ name: 'role', required: true }, { name: 'task', required: true }],
 *   { role: 'an analyst' },   // 'task' is missing → error
 * );
 */
export function lintPromptTemplate(
  template: string,
  variables: LintVariable[],
  values: Record<string, string | undefined>,
  context: LintContext = {},
): PromptLintResult[] {
  const results: PromptLintResult[] = [];
  const threshold = context.excessiveSizeThreshold ?? 8000;

  // ── 1. Empty template ─────────────────────────────────────
  if (!template || !template.trim()) {
    results.push({
      severity: 'error',
      rule: 'empty_template',
      message: 'Template is empty. Provide content for this prompt.',
    });
    // No further checks are meaningful on an empty template
    return results;
  }

  // ── 2. Excessive size ────────────────────────────────────
  if (template.length > threshold) {
    results.push({
      severity: 'info',
      rule: 'excessive_size',
      message:
        `Template is ${template.length.toLocaleString()} characters — above the ` +
        `${threshold.toLocaleString()} character guideline. Consider extracting ` +
        `large sections into fragments or separate prompts.`,
    });
  }

  // ── 3. Missing description ───────────────────────────────
  if (!context.description || !context.description.trim()) {
    results.push({
      severity: 'warning',
      rule: 'missing_description',
      message:
        'Prompt has no description. Descriptions are required for LLM-callable ' +
        'assets so the model can discover and route to this prompt correctly.',
    });
  }

  // ── 4. Fragment reference checks ─────────────────────────
  // Check for circular references left by resolveFragments()
  const circularMatches = [...template.matchAll(CIRCULAR_RE)];
  for (const m of circularMatches) {
    results.push({
      severity: 'error',
      rule: 'circular_fragment',
      subject: m[1],
      message:
        `Circular fragment reference detected: "{{>${m[1]}}}" eventually includes itself. ` +
        `Break the cycle by removing one of the mutual inclusions.`,
    });
  }

  // Check for unresolved `{{>key}}` markers (fragment not found)
  if (context.fragmentRegistry) {
    const referencedKeys = extractFragmentKeys(template);
    for (const key of referencedKeys) {
      // Skip circular markers already processed above
      if (key.startsWith('CIRCULAR:')) continue;
      const found = context.fragmentRegistry.get(key);
      if (!found) {
        results.push({
          severity: 'error',
          rule: 'unresolved_fragment',
          subject: key,
          message:
            `Fragment "{{>${key}}}" is not registered in the fragment registry. ` +
            `Create the fragment or remove the inclusion marker.`,
        });
      }
    }
  }

  // ── 5. Variable usage vs declaration cross-check ─────────
  // Collect all {{varName}} usages from the (fragment-expanded) template
  const usedVars = new Set<string>();
  let m: RegExpExecArray | null;
  const usageRe = new RegExp(VAR_USAGE_RE.source, 'g');
  while ((m = usageRe.exec(template)) !== null) {
    usedVars.add(m[1]!);
  }

  const declaredVars = new Map<string, LintVariable>(variables.map(v => [v.name, v]));

  // Variables used in template but not declared
  for (const name of usedVars) {
    if (!declaredVars.has(name)) {
      results.push({
        severity: 'warning',
        rule: 'missing_optional_variable',
        subject: name,
        message:
          `Template uses "{{${name}}}" but this variable is not declared in the ` +
          `variables list. Declare it so callers know what values to provide.`,
      });
    }
  }

  // Declared variables not used in template
  for (const [name] of declaredVars) {
    if (!usedVars.has(name)) {
      results.push({
        severity: 'info',
        rule: 'undefined_variable',
        subject: name,
        message:
          `Variable "${name}" is declared but not referenced in the template. ` +
          `Remove the declaration or add "{{${name}}}" to the template.`,
      });
    }
  }

  // Template has interpolation markers but no declarations at all
  if (usedVars.size > 0 && variables.length === 0) {
    results.push({
      severity: 'warning',
      rule: 'no_variables_declared',
      message:
        `Template contains ${usedVars.size} interpolation marker(s) but no ` +
        `variables are declared. Declare variables to enable lint, autocomplete, ` +
        `and required-value enforcement.`,
    });
  }

  // ── 6. Missing required variable values ──────────────────
  for (const [name, decl] of declaredVars) {
    if (!decl.required) continue;
    const hasDefault = decl.defaultValue != null && decl.defaultValue !== '';
    const hasValue = values[name] != null && values[name] !== '';
    if (!hasValue && !hasDefault) {
      results.push({
        severity: 'error',
        rule: 'missing_required_variable',
        subject: name,
        message:
          `Required variable "${name}" has no value and no default. ` +
          `Provide a value or set a defaultValue on the variable declaration.`,
      });
    }
  }

  return results;
}

// ─── Convenience helpers ──────────────────────────────────────

/**
 * Return true if lint results contain at least one error-severity diagnostic.
 * Use this to gate prompt deployment or render when strict validation is needed.
 *
 * @param results - Output from lintPromptTemplate().
 */
export function hasLintErrors(results: PromptLintResult[]): boolean {
  return results.some(r => r.severity === 'error');
}

/**
 * Return the highest severity level present in the results.
 * Returns null when results is empty (all clear).
 *
 * @param results - Output from lintPromptTemplate().
 */
export function topLintSeverity(results: PromptLintResult[]): PromptLintSeverity | null {
  if (results.some(r => r.severity === 'error')) return 'error';
  if (results.some(r => r.severity === 'warning')) return 'warning';
  if (results.some(r => r.severity === 'info')) return 'info';
  return null;
}

/**
 * Format lint results as a human-readable summary string.
 * Useful for log output, CI annotations, and trace metadata.
 *
 * @param results - Output from lintPromptTemplate().
 * @param promptKey - Optional prompt identifier to include in the summary header.
 */
export function formatLintResults(results: PromptLintResult[], promptKey?: string): string {
  if (!results.length) return promptKey ? `✓ ${promptKey}: no lint issues` : '✓ No lint issues';

  const prefix = promptKey ? `${promptKey}: ` : '';
  const header = `${prefix}${results.length} lint issue(s)`;
  const lines = results.map(r => {
    const icon = r.severity === 'error' ? '✗' : r.severity === 'warning' ? '⚠' : 'ℹ';
    const subject = r.subject ? ` [${r.subject}]` : '';
    return `  ${icon} ${r.rule}${subject}: ${r.message}`;
  });

  return [header, ...lines].join('\n');
}
