/**
 * @weaveintel/prompts — Layered prompt frameworks
 *
 * A layered framework is a prompt held as ORDERED SECTIONS, each carrying a LOCK CLASS that says who may
 * change it and how changes from different layers combine. The vendor (the product that ships the prompt)
 * writes every section; an organisation (org) and a team may add to, or replace, only the sections the
 * vendor opened to them. Safety, fencing rules and output contracts stay exactly as shipped.
 *
 * LOCK CLASSES
 *   - locked   Vendor text only. An org or team overlay is IGNORED and reported by lint.
 *   - append   Vendor text, then the org's text, then the team's — each under its own small heading.
 *   - replace  The most specific non-empty layer wins: team, else org, else vendor.
 *   - runtime  Filled by code from `{{slot}}` values at render time. Overlays are ignored and reported.
 *
 * SLOTS
 *   Vendor content may carry `{{name}}` placeholders (letters, digits, `_`, `.`). Values are inserted
 *   VERBATIM: the caller is responsible for fencing untrusted text before passing it (fencing is never a
 *   section — see @weaveintel/guardrails). Overlay text is never slot-expanded: an organisation's words
 *   cannot reach a runtime value.
 *
 * WHY: a prompt that is a code constant cannot be adapted by the people who run the product, and a prompt
 * that is one editable text blob lets an administrator delete its safety rules by accident. Sections with
 * lock classes give both: the vendor keeps what must not change, and everything else is theirs.
 */

import { createHash } from 'node:crypto';

/** Who may change a section and how layers combine. */
export type SectionLockClass = 'locked' | 'append' | 'replace' | 'runtime';

/** The layers a prompt is built from, least specific first. */
export type PromptLayerName = 'vendor' | 'org' | 'team';

/** Least specific first: the order layers are applied in. */
export const PROMPT_LAYER_ORDER: readonly PromptLayerName[] = ['vendor', 'org', 'team'];

/** One section of a layered framework, as the vendor ships it. */
export interface LayeredSectionDef {
  /** Stable machine key, unique in the framework (e.g. `role`, `house_rules`). */
  readonly key: string;
  /** Human label for the admin UI. */
  readonly label: string;
  /** Position in the rendered prompt (lower first). Equal orders keep declaration order. */
  readonly renderOrder: number;
  /** Who may change it. */
  readonly lock: SectionLockClass;
  /** Text put before the section's content when it renders (e.g. `## Task\n`). Omitted = none. */
  readonly header?: string | null;
  /** The vendor's content. May carry `{{slot}}` placeholders. Empty = the section shows only overlays. */
  readonly content: string;
  /** Heading put before an org's appended text (append sections). Default: `From this organisation:\n`. */
  readonly orgHeading?: string;
  /** Heading put before a team's appended text (append sections). Default: `From this team:\n`. */
  readonly teamHeading?: string;
  /** A short sentence for the admin UI: what this section is for. */
  readonly help?: string;
}

/** A framework whose sections carry lock classes. */
export interface LayeredFramework {
  /** Stable key (e.g. `geni.dock.ask`). */
  readonly key: string;
  /** Human name. */
  readonly name: string;
  /** What the prompt is for. */
  readonly description?: string;
  /** Put between non-empty rendered sections. Default `\n\n`. */
  readonly sectionSeparator?: string;
  /**
   * Trim each section's rendered content before deciding whether it is empty and joining it. Default
   * `true` — the same rule `renderFramework` applies, so a framework migrated from it renders identically.
   */
  readonly trimSections?: boolean;
  /** The sections, in any order (rendered by `renderOrder`). */
  readonly sections: readonly LayeredSectionDef[];
}

/** One layer's text for one section. */
export interface SectionOverlay {
  readonly sectionKey: string;
  readonly layer: Exclude<PromptLayerName, 'vendor'>;
  /** Whose layer: the tenant id for an org overlay, the team id for a team overlay. */
  readonly scopeRef?: string;
  readonly content: string;
  /** The version this text came from, for the trace. */
  readonly versionRef?: string;
}

/** What render-time callers may supply. */
export interface LayeredRenderOptions {
  /** Runtime values for `{{slot}}` placeholders. Inserted verbatim (fence untrusted text first). */
  readonly slots?: Readonly<Record<string, string>>;
  /** Section keys the caller leaves out of this render (a conditional part of the prompt). */
  readonly omit?: readonly string[];
  /** Throw on a lint error instead of reporting it. */
  readonly strict?: boolean;
}

/** A finding about a framework or its overlays. */
export interface PromptLintIssue {
  readonly code:
    | 'LOCKED_SECTION_OVERLAY'
    | 'RUNTIME_SECTION_OVERLAY'
    | 'UNKNOWN_SECTION'
    | 'MISSING_SLOT'
    | 'SLOT_IN_OVERLAY'
    | 'DUPLICATE_SECTION';
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly sectionKey?: string;
  readonly layer?: PromptLayerName;
  readonly slot?: string;
}

/** One section as it rendered. */
export interface MergedSection {
  readonly key: string;
  readonly lock: SectionLockClass;
  /** The section's rendered text (header included), or '' when it did not render. */
  readonly text: string;
  /** Which layers contributed text. */
  readonly contributors: readonly PromptLayerName[];
}

/** The result of merging and rendering a layered framework. */
export interface LayeredRenderResult {
  readonly frameworkKey: string;
  readonly text: string;
  /** sha256 of `text`, hex — put it on the trace so every answer names the prompt that produced it. */
  readonly hash: string;
  readonly sections: readonly MergedSection[];
  /** Overlays that were not applied (locked, runtime or unknown sections). */
  readonly ignored: readonly SectionOverlay[];
  readonly lint: readonly PromptLintIssue[];
  /** The version refs of the overlays that were applied, for the trace. */
  readonly versionRefs: readonly string[];
}

/** The sha256 of a rendered prompt, hex. */
export function promptHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const SLOT = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** The slot names a piece of text uses, in order of first appearance. */
export function slotsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SLOT)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Whether a layer may write a section of this lock class, and why not. */
export function canLayerWrite(
  section: Pick<LayeredSectionDef, 'lock' | 'key'>,
  layer: PromptLayerName,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (layer === 'vendor') return { ok: true };
  if (section.lock === 'locked') return { ok: false, reason: `The "${section.key}" section is set by the product and cannot be changed.` };
  if (section.lock === 'runtime') return { ok: false, reason: `The "${section.key}" section is filled in by the product at the moment of the call and cannot be edited.` };
  return { ok: true };
}

/**
 * Check a framework and its overlays without rendering: unknown sections, overlays on locked or runtime
 * sections, slot syntax inside overlay text, duplicate section keys.
 */
export function lintLayers(framework: LayeredFramework, overlays: readonly SectionOverlay[] = []): PromptLintIssue[] {
  const issues: PromptLintIssue[] = [];
  const byKey = new Map<string, LayeredSectionDef>();
  for (const s of framework.sections) {
    if (byKey.has(s.key)) issues.push({ code: 'DUPLICATE_SECTION', severity: 'error', sectionKey: s.key, message: `Framework "${framework.key}" declares section "${s.key}" twice.` });
    byKey.set(s.key, s);
  }
  for (const o of overlays) {
    const s = byKey.get(o.sectionKey);
    if (s === undefined) {
      issues.push({ code: 'UNKNOWN_SECTION', severity: 'error', sectionKey: o.sectionKey, layer: o.layer, message: `A ${o.layer} layer wrote section "${o.sectionKey}", which framework "${framework.key}" does not have.` });
      continue;
    }
    if (o.content.trim() === '') continue;
    if (s.lock === 'locked') issues.push({ code: 'LOCKED_SECTION_OVERLAY', severity: 'error', sectionKey: s.key, layer: o.layer, message: `A ${o.layer} layer wrote the locked section "${s.key}"; only the vendor text is used.` });
    else if (s.lock === 'runtime') issues.push({ code: 'RUNTIME_SECTION_OVERLAY', severity: 'error', sectionKey: s.key, layer: o.layer, message: `A ${o.layer} layer wrote the runtime section "${s.key}"; it is filled by code and the text is ignored.` });
    else if (slotsOf(o.content).length > 0) issues.push({ code: 'SLOT_IN_OVERLAY', severity: 'warning', sectionKey: s.key, layer: o.layer, message: `The ${o.layer} text for "${s.key}" contains {{…}}; overlay text is never filled in, so it shows literally.` });
  }
  return issues;
}

function fill(text: string, slots: Readonly<Record<string, string>>, sectionKey: string, lint: PromptLintIssue[]): string {
  return text.replace(SLOT, (_m, name: string) => {
    const v = slots[name];
    if (v === undefined) {
      lint.push({ code: 'MISSING_SLOT', severity: 'error', sectionKey, slot: name, message: `Section "${sectionKey}" needs the runtime value {{${name}}}, which was not supplied.` });
      return '';
    }
    return v;
  });
}

/**
 * Merge a framework's vendor sections with org and team overlays, by section key and lock class, fill the
 * runtime slots and render the prompt.
 *
 * With no overlays the result is exactly the vendor text: a host that moves a prompt from a code constant
 * into rows can prove byte parity before deleting the constant.
 *
 * @param framework The vendor framework.
 * @param overlays The org and team text for this call's scope (one team layer per call). Org overlays are
 *   applied before team overlays whatever order they arrive in; within a layer the input order is kept.
 * @param opts Runtime slots, sections to omit, strictness.
 */
export function mergeFrameworkLayers(
  framework: LayeredFramework,
  overlays: readonly SectionOverlay[] = [],
  opts: LayeredRenderOptions = {},
): LayeredRenderResult {
  const lint = lintLayers(framework, overlays);
  const slots = opts.slots ?? {};
  const omit = new Set(opts.omit ?? []);
  const trim = framework.trimSections !== false;
  const separator = framework.sectionSeparator ?? '\n\n';
  const known = new Set(framework.sections.map((s) => s.key));
  const ignored: SectionOverlay[] = [];
  const versionRefs: string[] = [];

  const forSection = (key: string, layer: 'org' | 'team'): SectionOverlay[] =>
    overlays.filter((o) => o.sectionKey === key && o.layer === layer && o.content.trim() !== '');

  for (const o of overlays) if (!known.has(o.sectionKey)) ignored.push(o);

  const ordered = framework.sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.renderOrder - b.s.renderOrder || a.i - b.i)
    .map((x) => x.s);

  const sections: MergedSection[] = [];
  const parts: string[] = [];
  for (const s of ordered) {
    if (omit.has(s.key)) {
      // Left out by the caller: nothing is filled, so its slots are not missing.
      sections.push({ key: s.key, lock: s.lock, text: '', contributors: [] });
      continue;
    }
    const org = forSection(s.key, 'org');
    const team = forSection(s.key, 'team');
    let body = '';
    const contributors: PromptLayerName[] = [];
    if (s.lock === 'locked' || s.lock === 'runtime') {
      ignored.push(...org, ...team);
      body = fill(s.content, slots, s.key, lint);
      if (body.trim() !== '') contributors.push('vendor');
    } else if (s.lock === 'replace') {
      const winner = team.at(-1) ?? org.at(-1);
      if (winner !== undefined) {
        body = winner.content;
        contributors.push(winner.layer);
        if (winner.versionRef !== undefined) versionRefs.push(winner.versionRef);
      } else {
        body = fill(s.content, slots, s.key, lint);
        if (body.trim() !== '') contributors.push('vendor');
      }
    } else {
      // append
      const pieces: string[] = [];
      const vendor = fill(s.content, slots, s.key, lint);
      if (vendor.trim() !== '') {
        pieces.push(trim ? vendor.trim() : vendor);
        contributors.push('vendor');
      }
      for (const o of org) {
        pieces.push(`${s.orgHeading ?? 'From this organisation:\n'}${o.content.trim()}`);
        if (o.versionRef !== undefined) versionRefs.push(o.versionRef);
      }
      if (org.length > 0) contributors.push('org');
      for (const o of team) {
        pieces.push(`${s.teamHeading ?? 'From this team:\n'}${o.content.trim()}`);
        if (o.versionRef !== undefined) versionRefs.push(o.versionRef);
      }
      if (team.length > 0) contributors.push('team');
      body = pieces.join('\n\n');
    }
    const content = trim ? body.trim() : body;
    if (content === '') {
      sections.push({ key: s.key, lock: s.lock, text: '', contributors: [] });
      continue;
    }
    const text = `${s.header ?? ''}${content}`;
    parts.push(text);
    sections.push({ key: s.key, lock: s.lock, text, contributors });
  }

  if (opts.strict === true) {
    const err = lint.find((l) => l.severity === 'error');
    if (err !== undefined) throw new Error(err.message);
  }
  const text = parts.join(separator);
  return { frameworkKey: framework.key, text, hash: promptHash(text), sections, ignored, lint, versionRefs };
}

/**
 * Build a vendor framework from plain section text, for a host seeding rows from what it shipped as code.
 * Each entry is `[key, lock, content]` or a full section definition; render orders are 10, 20, 30, ….
 */
export function layeredFramework(
  head: Pick<LayeredFramework, 'key' | 'name'> & Partial<Pick<LayeredFramework, 'description' | 'sectionSeparator' | 'trimSections'>>,
  sections: ReadonlyArray<readonly [string, SectionLockClass, string] | (Omit<LayeredSectionDef, 'renderOrder' | 'label'> & { readonly renderOrder?: number; readonly label?: string })>,
): LayeredFramework {
  return {
    ...head,
    sections: sections.map((entry, i) => {
      if (Array.isArray(entry)) {
        const [key, lock, content] = entry as readonly [string, SectionLockClass, string];
        return { key, label: key.replace(/_/g, ' '), renderOrder: (i + 1) * 10, lock, content };
      }
      const def = entry as Omit<LayeredSectionDef, 'renderOrder' | 'label'> & { readonly renderOrder?: number; readonly label?: string };
      return { ...def, label: def.label ?? def.key.replace(/_/g, ' '), renderOrder: def.renderOrder ?? (i + 1) * 10 };
    }),
  };
}
