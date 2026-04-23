/**
 * @weaveintel/prompts — Prompt template engine
 *
 * Compiles and renders prompt templates with {{variable}} substitution.
 * Supports default values, type coercion, and missing-variable detection.
 *
 * Phase 2 additions:
 *   - Fragment resolution: expand `{{>key}}` before variable interpolation.
 *   - Lint integration: run static analysis on templates at render time.
 *   - renderWithOptions(): unified render entry point with optional fragment
 *     registry, fragment registry, and lint result capture.
 */

import type {
  PromptTemplate,
  PromptVariable,
  PromptVersion,
  StructuredPromptMessage,
  TemplatePromptVersion,
  FewShotPromptVersion,
  JudgePromptVersion,
  OptimizerPromptVersion,
  ModalityPresetPromptVersion,
} from '@weaveintel/core';
import { resolveFragments, type FragmentRegistry, type ResolveFragmentsOptions } from './fragments.js';
import { lintPromptTemplate, type LintVariable, type LintContext, type PromptLintResult } from './lint.js';

// ─── Variable pattern ────────────────────────────────────────

const VAR_RE = /\{\{(\w+)\}\}/g;
const RAW_VAR_RE = /\{\{\{(\w+)\}\}\}/g;

export type TemplateRenderMode = 'legacy-raw' | 'escaped-default';

type TextRenderablePromptVersion =
  | TemplatePromptVersion
  | FewShotPromptVersion
  | JudgePromptVersion
  | OptimizerPromptVersion
  | ModalityPresetPromptVersion;

// ─── Template implementation ─────────────────────────────────

class WeavePromptTemplate implements PromptTemplate {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly template: string,
    public readonly variables: PromptVariable[],
    private readonly renderMode: TemplateRenderMode,
  ) {}

  render(values: Record<string, unknown>): string {
    const varMap = new Map(this.variables.map(v => [v.name, v]));

    // Triple-brace placeholders always insert raw values.
    const withRaw = this.template.replace(RAW_VAR_RE, (_match, varName: string) => {
      const spec = varMap.get(varName);
      const raw = values[varName] ?? spec?.defaultValue;
      if (raw === undefined || raw === null) {
        if (spec?.required) throw new Error(`Missing required variable "${varName}"`);
        return '';
      }
      return String(raw);
    });

    return withRaw.replace(VAR_RE, (_match, varName: string) => {
      const spec = varMap.get(varName);
      const raw = values[varName] ?? spec?.defaultValue;
      if (raw === undefined || raw === null) {
        if (spec?.required) throw new Error(`Missing required variable "${varName}"`);
        return '';
      }

      const interpolation = spec?.interpolation
        ?? (this.renderMode === 'escaped-default' ? 'escaped' : 'raw');

      const value = String(raw);
      return interpolation === 'escaped' ? escapePromptValue(value) : value;
    });
  }
}

function escapePromptValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
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
  renderMode?: TemplateRenderMode;
}): PromptTemplate {
  const detectedVars = new Set<string>();
  let m: RegExpExecArray | null;
  const reEscaped = new RegExp(VAR_RE.source, 'g');
  const reRaw = new RegExp(RAW_VAR_RE.source, 'g');
  while ((m = reEscaped.exec(opts.template)) !== null) detectedVars.add(m[1]!);
  while ((m = reRaw.exec(opts.template)) !== null) detectedVars.add(m[1]!);

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
    opts.renderMode ?? 'legacy-raw',
  );
}

/**
 * Create a prompt template that escapes variable values by default.
 * Use triple-brace placeholders (`{{{var}}}`) or `interpolation: 'raw'` when
 * a variable must be inserted without escaping.
 */
export function createSafeTemplate(opts: {
  id?: string;
  name: string;
  template: string;
  variables?: PromptVariable[];
}): PromptTemplate {
  return createTemplate({
    ...opts,
    renderMode: 'escaped-default',
  });
}

/**
 * Extract variable names from a template string.
 */
export function extractVariables(template: string): string[] {
  const vars = new Set<string>();
  let m: RegExpExecArray | null;
  const reEscaped = new RegExp(VAR_RE.source, 'g');
  const reRaw = new RegExp(RAW_VAR_RE.source, 'g');
  while ((m = reEscaped.exec(template)) !== null) vars.add(m[1]!);
  while ((m = reRaw.exec(template)) !== null) vars.add(m[1]!);
  return [...vars];
}

/**
 * Returns true when a prompt version can be rendered into plain text with the
 * shared interpolation engine. Phase 1 only executes prompt types that already
 * have a concrete text body.
 */
export function isTextRenderablePromptVersion(version: PromptVersion): version is TextRenderablePromptVersion {
  return version.kind === 'template'
    || version.kind === 'fewShot'
    || version.kind === 'judge'
    || version.kind === 'optimizer'
    || version.kind === 'modalityPreset';
}

/**
 * Render a prompt version into a string using the shared template engine.
 * This keeps GeneWeave and other apps from hand-parsing prompt records.
 */
export function renderPromptVersion(version: PromptVersion, values: Record<string, unknown>): string {
  if (isTextRenderablePromptVersion(version)) {
    return createTemplate({
      id: version.id,
      name: version.promptId,
      template: version.template,
      variables: version.variables,
    }).render(values);
  }

  if (version.kind === 'structured') {
    return version.messages.map((message) => {
      const rendered = createTemplate({
        name: `${version.promptId}:${message.role}`,
        template: message.content,
        variables: version.variables,
      }).render(values);
      return `[${message.role}] ${rendered}`;
    }).join('\n\n');
  }

  throw new Error(`Prompt kind "${version.kind}" is not yet directly renderable`);
}

/**
 * Render a structured prompt into message objects while reusing the same
 * interpolation semantics as text prompts.
 */
export function renderStructuredPromptMessages(
  messages: StructuredPromptMessage[],
  variables: PromptVariable[],
  values: Record<string, unknown>,
): StructuredPromptMessage[] {
  return messages.map((message) => ({
    ...message,
    content: createTemplate({
      name: message.role,
      template: message.content,
      variables,
    }).render(values),
  }));
}

/**
 * Render structured messages with escaped interpolation as the default mode.
 */
export function renderStructuredPromptMessagesSafe(
  messages: StructuredPromptMessage[],
  variables: PromptVariable[],
  values: Record<string, unknown>,
): StructuredPromptMessage[] {
  return messages.map((message) => ({
    ...message,
    content: createSafeTemplate({
      name: message.role,
      template: message.content,
      variables,
    }).render(values),
  }));
}

// ─── Phase 2: Unified render with fragments + lint ────────────

/**
 * Options for the unified renderWithOptions() entry point.
 */
export interface RenderWithOptions {
  /**
   * Fragment registry to expand `{{>key}}` inclusions before interpolation.
   * When omitted, fragment markers are left as-is (no expansion).
   */
  fragmentRegistry?: FragmentRegistry;
  /**
   * Options forwarded to resolveFragments() (maxDepth, strict mode).
   */
  fragmentOptions?: ResolveFragmentsOptions;
  /**
   * When true, run lint on the template after fragment expansion and
   * populate the `lintResults` field in the return value.
   * Lint is purely informational here — it never blocks rendering.
   */
  runLint?: boolean;
  /**
   * Context for lint checks (description, fragment registry, size threshold).
   * Only used when `runLint: true`.
   */
  lintContext?: LintContext;
  /**
   * Interpolation mode used by createTemplate during variable insertion.
   * Defaults to `escaped-default` for the unified Phase 2 entrypoint.
   */
  renderMode?: TemplateRenderMode;
}

/**
 * Return type of renderWithOptions() — the rendered text plus any lint output.
 */
export interface RenderResult {
  /** The fully rendered text after fragment expansion and variable interpolation. */
  text: string;
  /**
   * Template after fragment expansion but before variable interpolation.
   * Useful for debugging fragment resolution and lint reporting.
   */
  expandedTemplate: string;
  /**
   * Lint results from the template analysis, present when `runLint: true`.
   * Empty when lint is disabled or passes all checks.
   */
  lintResults: PromptLintResult[];
}

/**
 * Unified render function that combines fragment expansion, variable
 * interpolation, and optional lint into a single call.
 *
 * This is the recommended entry point for Phase 2+ rendering. It:
 *   1. Expands `{{>key}}` fragment inclusions (if a registry is provided).
 *   2. Runs lint on the expanded template (if runLint is true).
 *   3. Performs `{{variable}}` interpolation via the existing engine.
 *
 * Lint runs pre-interpolation (on the expanded template) so it can detect
 * fragment reference problems and variable usage issues before values are
 * substituted in.
 *
 * @param template  - Raw template string (may contain `{{>fragment}}` markers).
 * @param variables - Variable declarations for lint and interpolation.
 * @param values    - Actual variable values for interpolation.
 * @param options   - Fragment and lint configuration.
 * @returns RenderResult with text, expandedTemplate, and lintResults.
 *
 * @example
 * const result = renderWithOptions(
 *   'You are {{role}}. {{>safety_notice}}',
 *   [{ name: 'role', required: true }],
 *   { role: 'an analyst' },
 *   { fragmentRegistry: myRegistry, runLint: true },
 * );
 */
export function renderWithOptions(
  template: string,
  variables: PromptVariable[],
  values: Record<string, unknown>,
  options: RenderWithOptions = {},
): RenderResult {
  // Step 1: Expand fragment inclusions before interpolation
  const expandedTemplate = options.fragmentRegistry
    ? resolveFragments(template, options.fragmentRegistry, options.fragmentOptions)
    : template;

  // Step 2: Optionally run lint on the expanded template
  const lintVariables: LintVariable[] = variables.map(v => ({
    name: v.name,
    required: v.required,
    defaultValue: typeof v.defaultValue === 'string' ? v.defaultValue : undefined,
    description: v.description,
  }));

  const stringValues: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    stringValues[k] = v != null ? String(v) : undefined;
  }

  const lintResults: PromptLintResult[] = options.runLint
    ? lintPromptTemplate(expandedTemplate, lintVariables, stringValues, {
        ...options.lintContext,
        fragmentRegistry: options.fragmentRegistry ?? options.lintContext?.fragmentRegistry,
      })
    : [];

  // Step 3: Interpolate variables into the expanded template
  const tpl = createTemplate({
    name: 'renderWithOptions',
    template: expandedTemplate,
    variables,
    renderMode: options.renderMode ?? 'escaped-default',
  });

  const text = tpl.render(values);

  return { text, expandedTemplate, lintResults };
}
