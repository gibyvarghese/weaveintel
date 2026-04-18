/**
 * @weaveintel/prompts — Prompt framework registry
 *
 * A framework is a named, ordered collection of typed sections that structures
 * how a prompt is assembled. Instead of a flat text blob, prompts using a
 * framework are composed section-by-section (role → task → context → constraints
 * → examples → output_contract) with each section clearly labelled and ordered.
 *
 * WHY: Frameworks make prompt structure explicit and configurable. Teams can
 * define their own section vocabulary, enforce required sections, reorder for
 * different providers, and evolve the structure without editing every prompt.
 *
 * USAGE:
 *   1. Register a framework in the FrameworkRegistry.
 *   2. When building a prompt, provide content keyed by section.
 *   3. Call renderFramework() to assemble the final text in defined order.
 *   4. GeneWeave stores frameworks in the `prompt_frameworks` DB table.
 *
 * RELATIONSHIP TO PROMPTS:
 *   A prompt record can reference a framework key via its `framework` field.
 *   When the `framework` field is a key string (e.g. "rtce"), the chat engine
 *   loads the framework from DB, parses the prompt template as a sectioned
 *   JSON map, and renders section-by-section before sending to the model.
 *
 * SECTION VOCABULARY (built-in):
 *   - role              Who the model is playing (system context)
 *   - task              What the model must do
 *   - context           Background information the model needs
 *   - expectations      Quality or behaviour expectations
 *   - constraints       Hard limits the model must not violate
 *   - examples          Few-shot demonstrations
 *   - output_contract   Required output shape or format rules
 *   - review_instructions  Self-review or critique instructions
 *   - custom            Application-specific catch-all section
 *
 * PROVIDER ADAPTERS:
 *   Use renderFrameworkForProvider() to produce the right format per LLM
 *   provider: a single system string for OpenAI, or a messages[] array for
 *   providers that support explicit role separation.
 */

import type { PromptFrameworkSection } from '@weaveintel/core';

// ─── Section name union ──────────────────────────────────────

/**
 * Well-known section keys in the standard prompt framework vocabulary.
 * Apps may use additional string keys for custom sections.
 */
export type BuiltinSectionKey =
  | 'role'
  | 'task'
  | 'context'
  | 'expectations'
  | 'constraints'
  | 'examples'
  | 'output_contract'
  | 'review_instructions'
  | 'custom';

// ─── Framework definition ────────────────────────────────────

/**
 * Defines the ordered template for a framework, including which sections are
 * required and how they are labelled for display in the admin UI.
 *
 * `sections` are ordered by renderOrder ascending. Sections without content
 * provided at render time are skipped unless `required: true` (which throws).
 */
export interface PromptFramework {
  /** Stable machine-readable key used as the reference in prompt records. */
  key: string;
  /** Human-readable name shown in the admin UI. */
  name: string;
  /**
   * Model-facing description: what this framework structures, which prompt
   * types it suits, and how a model should interpret each section.
   */
  description: string;
  /** Ordered section definitions for this framework. */
  sections: PromptFrameworkSectionDef[];
  /**
   * Separator inserted between non-empty rendered sections.
   * Defaults to "\n\n" for clean paragraph separation.
   */
  sectionSeparator?: string;
}

/**
 * A single section definition within a framework.
 * Extends the core PromptFrameworkSection contract with render metadata.
 */
export interface PromptFrameworkSectionDef {
  /** Machine-readable section key (e.g. 'role', 'task'). */
  key: string;
  /** Human-readable label used in admin UI and debug output. */
  label: string;
  /**
   * Position in the final rendered output (lower = earlier).
   * Sections with identical renderOrder are ordered by insertion order.
   */
  renderOrder: number;
  /** When true, renderFramework() throws if no content is provided. */
  required?: boolean;
  /**
   * Default content injected when no content is supplied by the caller.
   * Allows frameworks to include boilerplate sections automatically.
   */
  defaultContent?: string;
  /**
   * Optional header prefix prepended to the section content in text output.
   * Example: "## Context\n" to add a Markdown header before the section body.
   * Pass null to suppress the header entirely.
   */
  header?: string | null;
}

// ─── Rendered output types ───────────────────────────────────

/**
 * Result of rendering a framework into text output.
 * Contains the assembled text plus a record of which sections were included.
 */
export interface FrameworkRenderResult {
  /**
   * The fully assembled prompt string with all sections joined by the
   * framework's sectionSeparator.
   */
  text: string;
  /**
   * Ordered list of section keys that contributed content to the output.
   * Useful for observability and lint reporting.
   */
  renderedSections: string[];
  /**
   * List of section keys that were skipped because no content was supplied
   * and they were not required.
   */
  skippedSections: string[];
}

// ─── Framework registry interface ────────────────────────────

/**
 * Stores and retrieves prompt frameworks by key.
 * Implementations can be in-memory (for package defaults) or DB-backed
 * (for GeneWeave and other apps that store frameworks via admin CRUD).
 */
export interface FrameworkRegistry {
  /**
   * Register a framework. Overwrites any existing framework with the same key.
   * @param framework - The framework definition to store.
   */
  register(framework: PromptFramework): void;
  /**
   * Look up a framework by its stable key.
   * Returns null when no framework with that key exists.
   */
  get(key: string): PromptFramework | null;
  /**
   * List all registered frameworks.
   * Used by the admin UI to populate the framework dropdown on prompt forms.
   */
  list(): PromptFramework[];
}

// ─── In-memory registry ──────────────────────────────────────

/**
 * Default in-memory framework registry pre-loaded with built-in frameworks.
 * GeneWeave overlays DB-sourced frameworks on top of this registry at startup.
 */
export class InMemoryFrameworkRegistry implements FrameworkRegistry {
  private frameworks = new Map<string, PromptFramework>();

  register(framework: PromptFramework): void {
    this.frameworks.set(framework.key, framework);
  }

  get(key: string): PromptFramework | null {
    return this.frameworks.get(key) ?? null;
  }

  list(): PromptFramework[] {
    return [...this.frameworks.values()];
  }
}

// ─── DB record adapter ────────────────────────────────────────

/**
 * Shape of a row from the `prompt_frameworks` DB table in GeneWeave.
 * The `sections` column stores the section definitions as serialised JSON.
 */
export interface PromptFrameworkRecordLike {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  sections?: string | null; // JSON array of PromptFrameworkSectionDef
  section_separator?: string | null;
  enabled?: number | boolean | null;
}

/**
 * Convert a `prompt_frameworks` DB row into a typed PromptFramework.
 * Used by GeneWeave's DB adapter to hydrate framework records into the
 * shared package type so apps don't parse raw JSON by hand.
 *
 * @param record - A raw DB row from the prompt_frameworks table.
 */
export function frameworkFromRecord(record: PromptFrameworkRecordLike): PromptFramework {
  let sections: PromptFrameworkSectionDef[] = [];
  if (record.sections) {
    try {
      const parsed = JSON.parse(record.sections);
      if (Array.isArray(parsed)) {
        sections = parsed as PromptFrameworkSectionDef[];
      }
    } catch {
      // Fall through with empty sections — treated as a no-op framework
    }
  }
  return {
    key: record.key,
    name: record.name,
    description: record.description ?? '',
    sections,
    sectionSeparator: record.section_separator ?? '\n\n',
  };
}

// ─── Rendering ───────────────────────────────────────────────

/**
 * Assemble a prompt from framework sections and a content map.
 *
 * Content is provided as a map from section key → text. Sections are
 * rendered in ascending renderOrder, with headers prepended when defined.
 * Missing required sections throw; missing optional sections are silently
 * skipped unless a defaultContent is configured on the section definition.
 *
 * @param framework   - The framework definition controlling section order.
 * @param contentMap  - Map of section key → raw text content for that section.
 * @returns FrameworkRenderResult with assembled text and section accounting.
 *
 * @throws Error when a required section has no content and no defaultContent.
 *
 * @example
 * const result = renderFramework(myFramework, {
 *   role: 'You are a code reviewer.',
 *   task: 'Review the following TypeScript code for bugs.',
 *   output_contract: 'Return a JSON array of { line, severity, message }.',
 * });
 * console.log(result.text);
 */
export function renderFramework(
  framework: PromptFramework,
  contentMap: Record<string, string>,
): FrameworkRenderResult {
  const separator = framework.sectionSeparator ?? '\n\n';
  const sorted = [...framework.sections].sort((a, b) => a.renderOrder - b.renderOrder);

  const renderedParts: string[] = [];
  const renderedSections: string[] = [];
  const skippedSections: string[] = [];

  for (const section of sorted) {
    const rawContent = contentMap[section.key] ?? section.defaultContent ?? '';
    const content = rawContent.trim();

    if (!content) {
      if (section.required) {
        throw new Error(
          `Framework "${framework.key}" requires section "${section.key}" but no content was provided.`,
        );
      }
      skippedSections.push(section.key);
      continue;
    }

    // Prepend the section header when defined. null suppresses the header.
    let rendered = content;
    if (section.header === undefined) {
      // Default auto-header: bold label
      rendered = `**${section.label}**\n${content}`;
    } else if (section.header !== null) {
      rendered = `${section.header}${content}`;
    }

    renderedParts.push(rendered);
    renderedSections.push(section.key);
  }

  return {
    text: renderedParts.join(separator),
    renderedSections,
    skippedSections,
  };
}

// ─── Built-in frameworks ──────────────────────────────────────

/**
 * Standard RTCE (Role / Task / Context / Expectations) framework.
 * A concise 4-section structure suitable for most task-oriented prompts.
 * Role and Task are required; Context and Expectations are optional.
 */
export const FRAMEWORK_RTCE: PromptFramework = {
  key: 'rtce',
  name: 'RTCE (Role / Task / Context / Expectations)',
  description:
    'Four-section framework for focused task prompts. Role sets model persona, ' +
    'Task defines the goal, Context provides background, Expectations capture quality targets. ' +
    'Use for well-scoped single-purpose prompts where constraints are implied by context.',
  sectionSeparator: '\n\n',
  sections: [
    { key: 'role',         label: 'Role',         renderOrder: 10, required: true,  header: null },
    { key: 'task',         label: 'Task',         renderOrder: 20, required: true,  header: '## Task\n' },
    { key: 'context',      label: 'Context',      renderOrder: 30, required: false, header: '## Context\n' },
    { key: 'expectations', label: 'Expectations', renderOrder: 40, required: false, header: '## Expectations\n' },
  ],
};

/**
 * Full structured framework with all standard sections.
 * Use for complex, multi-constraint prompts where explicit constraints,
 * examples, and output contracts improve reliability.
 */
export const FRAMEWORK_FULL: PromptFramework = {
  key: 'full',
  name: 'Full (Role / Task / Context / Constraints / Examples / Output)',
  description:
    'Six-section framework for high-reliability prompts. Adds Constraints and ' +
    'Output Contract sections to RTCE, plus optional few-shot Examples. ' +
    'Use for production prompts where format compliance and safety constraints are critical.',
  sectionSeparator: '\n\n',
  sections: [
    { key: 'role',            label: 'Role',            renderOrder: 10, required: true,  header: null },
    { key: 'task',            label: 'Task',            renderOrder: 20, required: true,  header: '## Task\n' },
    { key: 'context',         label: 'Context',         renderOrder: 30, required: false, header: '## Context\n' },
    { key: 'constraints',     label: 'Constraints',     renderOrder: 40, required: false, header: '## Constraints\n' },
    { key: 'examples',        label: 'Examples',        renderOrder: 50, required: false, header: '## Examples\n' },
    { key: 'output_contract', label: 'Output Contract', renderOrder: 60, required: false, header: '## Output Format\n' },
  ],
};

/**
 * Critique-and-revise framework. Used for prompts that ask the model to
 * reason about an artifact and produce a revised or annotated version.
 */
export const FRAMEWORK_CRITIQUE: PromptFramework = {
  key: 'critique',
  name: 'Critique & Revise (Role / Task / Subject / Criteria / Output)',
  description:
    'Five-section framework for review and improvement prompts. The Subject ' +
    'section carries the artifact to be reviewed; Criteria defines what the model ' +
    'should look for. Use for code review, document review, and output refinement prompts.',
  sectionSeparator: '\n\n',
  sections: [
    { key: 'role',            label: 'Role',            renderOrder: 10, required: true,  header: null },
    { key: 'task',            label: 'Task',            renderOrder: 20, required: true,  header: '## Task\n' },
    { key: 'context',         label: 'Subject / Input', renderOrder: 30, required: false, header: '## Subject\n' },
    { key: 'constraints',     label: 'Review Criteria', renderOrder: 40, required: false, header: '## Review Criteria\n' },
    { key: 'output_contract', label: 'Output Contract', renderOrder: 50, required: false, header: '## Output Format\n' },
  ],
};

/**
 * Judge/eval framework. Used for prompts that score or evaluate another model's
 * output according to a rubric. Commonly wired as the judge prompt in evals.
 */
export const FRAMEWORK_JUDGE: PromptFramework = {
  key: 'judge',
  name: 'Judge / Evaluator (Role / Task / Rubric / Output)',
  description:
    'Four-section framework for LLM-as-judge prompts. Rubric carries the ' +
    'scoring criteria; Output Contract enforces score format (e.g. JSON with score, ' +
    'rationale, passed). Use when a model evaluates another model\'s completion.',
  sectionSeparator: '\n\n',
  sections: [
    { key: 'role',            label: 'Judge Role',      renderOrder: 10, required: true,  header: null },
    { key: 'task',            label: 'Evaluation Task', renderOrder: 20, required: true,  header: '## Task\n' },
    { key: 'constraints',     label: 'Rubric',          renderOrder: 30, required: false, header: '## Rubric\n' },
    { key: 'output_contract', label: 'Output Contract', renderOrder: 40, required: true,  header: '## Output Format\n' },
  ],
};

// ─── Default registry ─────────────────────────────────────────

/**
 * Singleton in-memory registry pre-loaded with built-in frameworks.
 * GeneWeave loads DB frameworks on top of this via loadFrameworksIntoRegistry().
 * Other apps can import this directly or create their own registry instance.
 */
export const defaultFrameworkRegistry = new InMemoryFrameworkRegistry();
defaultFrameworkRegistry.register(FRAMEWORK_RTCE);
defaultFrameworkRegistry.register(FRAMEWORK_FULL);
defaultFrameworkRegistry.register(FRAMEWORK_CRITIQUE);
defaultFrameworkRegistry.register(FRAMEWORK_JUDGE);

// ─── Core type re-export for convenience ─────────────────────

// Re-export core section type so callers don't need a separate import
export type { PromptFrameworkSection };
