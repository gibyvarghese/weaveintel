/**
 * @weaveintel/prompts — Prompt fragment/partial registry
 *
 * Fragments are reusable, versioned text blocks that can be embedded inside
 * any prompt template using the inclusion syntax `{{>fragmentKey}}`.
 *
 * WHY: Large-scale prompt libraries accumulate repetitive boilerplate — safety
 * disclaimers, JSON output instructions, company persona headers, date stamps.
 * Fragments let that shared text live in one DB row, be updated once, and
 * take effect across every prompt that includes it — without copy-pasting.
 *
 * SYNTAX: `{{>key}}` inside a template triggers fragment resolution.
 * The `>` prefix distinguishes inclusion from variable substitution (`{{var}}`).
 * Fragment keys are resolved before variable interpolation so that fragment
 * content can itself contain template variables.
 *
 * CHAINING: Fragments may include other fragments up to a configurable depth
 * limit (default 5). Circular references are detected and reported as lint errors.
 *
 * VARIABLES: Fragments can declare variables just like prompt templates.
 * Variables inside fragments are resolved from the same variable map as the
 * parent prompt, allowing fragments to be context-aware.
 *
 * DB STORAGE: GeneWeave stores fragments in the `prompt_fragments` table.
 * Use FragmentRecordLike to parse DB rows into FragmentDefinition objects via
 * fragmentFromRecord().
 *
 * USAGE:
 *   const registry = new InMemoryFragmentRegistry();
 *   registry.register({ key: 'json_output', name: 'JSON Output', content: '...' });
 *   const expanded = resolveFragments(template, registry);
 *
 * LINT: Unresolved `{{>key}}` references are reported by the lint module as
 * `unresolved_fragment` errors so template authors learn about missing fragments
 * before production deployment.
 */

// ─── Fragment definition ──────────────────────────────────────

/**
 * A reusable text block that can be embedded in prompt templates.
 * Treated as a mini-template: may itself reference variables and other fragments.
 */
export interface FragmentDefinition {
  /** Stable key used in the `{{>key}}` inclusion syntax. */
  key: string;
  /** Human-readable name shown in the admin UI. */
  name: string;
  /**
   * Model-facing description: what this fragment adds, which prompts use it,
   * and any constraints the including prompt must satisfy.
   * Required for fragments that are LLM-callable or team-visible.
   */
  description?: string;
  /**
   * The raw text content of the fragment.
   * May contain `{{variable}}` interpolations and `{{>otherKey}}` inclusions.
   */
  content: string;
  /**
   * Variable declarations understood by this fragment.
   * Mirrors the PromptVariable shape from @weaveintel/core.
   * Used for lint validation — unset required fragment variables are flagged.
   */
  variables?: FragmentVariable[];
  /** Free-form tags for admin search and filtering. */
  tags?: string[];
  /**
   * Optional semantic category grouping this fragment with related ones
   * (e.g. 'output-contracts', 'personas', 'safety').
   */
  category?: string;
  /** Version label for change tracking. */
  version?: string;
}

/**
 * A variable declared by a fragment.
 * Mirrors the PromptVariable shape without pulling in the full prompts type.
 */
export interface FragmentVariable {
  name: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
}

// ─── DB record adapter ────────────────────────────────────────

/**
 * Shape of a row from the `prompt_fragments` table in GeneWeave.
 * `variables` column stores JSON-serialised FragmentVariable[].
 * `tags` column stores a JSON-serialised string[].
 */
export interface FragmentRecordLike {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  content: string;
  variables?: string | null; // JSON array of FragmentVariable
  tags?: string | null;      // JSON array of strings
  category?: string | null;
  version?: string | null;
  enabled?: number | boolean | null;
}

/**
 * Convert a `prompt_fragments` DB row into a typed FragmentDefinition.
 * Used by GeneWeave's DB adapter so apps don't parse raw JSON manually.
 *
 * @param record - Raw DB row from the prompt_fragments table.
 */
export function fragmentFromRecord(record: FragmentRecordLike): FragmentDefinition {
  let variables: FragmentVariable[] = [];
  if (record.variables) {
    try {
      const parsed = JSON.parse(record.variables);
      if (Array.isArray(parsed)) variables = parsed as FragmentVariable[];
    } catch { /* ignore malformed JSON */ }
  }

  let tags: string[] = [];
  if (record.tags) {
    try {
      const parsed = JSON.parse(record.tags);
      if (Array.isArray(parsed)) tags = parsed as string[];
    } catch { /* ignore */ }
  }

  return {
    key: record.key,
    name: record.name,
    description: record.description ?? undefined,
    content: record.content,
    variables: variables.length ? variables : undefined,
    tags: tags.length ? tags : undefined,
    category: record.category ?? undefined,
    version: record.version ?? undefined,
  };
}

// ─── Fragment registry interface ──────────────────────────────

/**
 * Stores and retrieves fragment definitions by key.
 * Implementations may be in-memory (unit tests, package defaults) or
 * DB-backed (GeneWeave and other apps that manage fragments via admin CRUD).
 */
export interface FragmentRegistry {
  /**
   * Register a fragment. Overwrites any existing fragment with the same key.
   */
  register(fragment: FragmentDefinition): void;
  /**
   * Look up a fragment by its inclusion key.
   * Returns null when the key is not registered.
   */
  get(key: string): FragmentDefinition | null;
  /**
   * List all registered fragments.
   * Used by the admin UI to populate fragment listings and autocomplete.
   */
  list(): FragmentDefinition[];
}

// ─── In-memory registry ───────────────────────────────────────

/**
 * Default in-memory fragment registry.
 * GeneWeave overlays DB fragments on top of any defaults at startup.
 */
export class InMemoryFragmentRegistry implements FragmentRegistry {
  private fragments = new Map<string, FragmentDefinition>();

  register(fragment: FragmentDefinition): void {
    this.fragments.set(fragment.key, fragment);
  }

  get(key: string): FragmentDefinition | null {
    return this.fragments.get(key) ?? null;
  }

  list(): FragmentDefinition[] {
    return [...this.fragments.values()];
  }
}

// ─── Fragment resolution ──────────────────────────────────────

/**
 * Regex that matches `{{>key}}` fragment inclusion markers.
 * Capture group 1 = the key (alphanumeric, underscores, hyphens, dots).
 * Does NOT match `{{variable}}` (no `>` prefix) to keep the two syntaxes clear.
 */
const FRAGMENT_RE = /\{\{>\s*([\w.\-]+)\s*\}\}/g;

/**
 * Options controlling fragment resolution behaviour.
 */
export interface ResolveFragmentsOptions {
  /**
   * Maximum depth for nested fragment includes.
   * Prevents runaway recursion from circular fragment graphs.
   * Default: 5.
   */
  maxDepth?: number;
  /**
   * Whether to throw on an unresolved fragment key (strict mode).
   * When false (default), unresolved markers are left in the template as-is
   * so that the lint module can report them without crashing the render.
   */
  strict?: boolean;
}

/**
 * Expand all `{{>key}}` inclusion markers in a template by substituting the
 * matching fragment's content. Fragment content is recursively expanded up to
 * `maxDepth` levels deep, with circular-reference detection.
 *
 * This runs BEFORE variable interpolation so that fragment content can contain
 * `{{variable}}` markers that are resolved in the final interpolation pass.
 *
 * @param template - The raw template string potentially containing inclusions.
 * @param registry - The fragment registry to resolve keys from.
 * @param options  - Depth and strictness controls.
 * @returns The template with all resolvable `{{>key}}` markers replaced.
 *
 * @example
 * registry.register({ key: 'json_output', content: 'Respond only with valid JSON.' });
 * const expanded = resolveFragments('Help the user. {{>json_output}}', registry);
 * // → 'Help the user. Respond only with valid JSON.'
 */
export function resolveFragments(
  template: string,
  registry: FragmentRegistry,
  options: ResolveFragmentsOptions = {},
): string {
  const maxDepth = options.maxDepth ?? 5;
  const strict = options.strict ?? false;

  function expand(text: string, depth: number, visited: Set<string>): string {
    if (depth > maxDepth) {
      // Depth exceeded — leave remaining markers intact for lint to flag
      return text;
    }

    return text.replace(FRAGMENT_RE, (_match, key: string) => {
      if (visited.has(key)) {
        // Circular reference: leave marker so lint can flag it
        return `{{>CIRCULAR:${key}}}`;
      }
      const fragment = registry.get(key);
      if (!fragment) {
        if (strict) {
          throw new Error(
            `Fragment "{{>${key}}}" not found in registry. ` +
            `Register the fragment or remove the inclusion marker.`,
          );
        }
        // Non-strict: leave the marker intact for lint reporting
        return `{{>${key}}}`;
      }
      // Expand the fragment's content recursively, tracking visited keys to
      // prevent circular reference loops
      const nextVisited = new Set(visited).add(key);
      return expand(fragment.content, depth + 1, nextVisited);
    });
  }

  return expand(template, 0, new Set());
}

/**
 * Extract all `{{>key}}` fragment inclusion keys referenced in a template.
 * Used by the lint module to check which fragments must be registered.
 *
 * @param template - The raw template string to scan.
 * @returns Deduplicated list of fragment keys referenced in the template.
 */
export function extractFragmentKeys(template: string): string[] {
  const keys = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(FRAGMENT_RE.source, 'g');
  while ((match = re.exec(template)) !== null) {
    keys.add(match[1]!);
  }
  return [...keys];
}

// ─── Default registry ─────────────────────────────────────────

/**
 * Singleton in-memory fragment registry.
 * Applications that want shared fragments across modules import this.
 * GeneWeave populates it from the `prompt_fragments` table at startup.
 */
export const defaultFragmentRegistry = new InMemoryFragmentRegistry();
