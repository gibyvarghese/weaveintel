// SPDX-License-Identifier: MIT
/**
 * Interop — moving skills in and out of the open `SKILL.md` standard, and over MCP.
 *
 * A skill is only as valuable as the places it can go. The open Agent-Skills format (agentskills.io)
 * is understood by many tools — Claude Code, Cursor, Codex and others — so this module lets you:
 *   • **import** a `SKILL.md` someone else wrote and turn it into a first-class skill here, and
 *   • **export** one of your skills back out as a `SKILL.md` anyone can use.
 *
 * Import is deliberately *distrustful*: anything from outside enters at the lowest trust tier (T1) and
 * is run through the full security scan (Phase 3) before you decide what to do with it. Nothing is
 * trusted just because it was imported — that's how registries get poisoned.
 *
 * Export is the mirror image of the Phase-2 parser, so a round trip (export → import) is lossless.
 */

import { parseSkillPackage, skillPackageToDefinition, type SkillPackage } from './skill-package.js';
import { assessSkillPackage, type SkillAssessment, type AssessOptions } from './skill-security.js';
import type { SkillDefinition } from './types.js';

// ── Export ───────────────────────────────────────────────────────────────────────────────────────

function emitFrontmatterLine(key: string, value: string | readonly string[] | undefined): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.length ? `${key}: [${value.join(', ')}]` : undefined;
  return String(value) ? `${key}: ${value as string}` : undefined;
}

/** Serialise a package's `SKILL.md` (frontmatter + body). The inverse of the Phase-2 parser. */
export function exportSkillMd(pkg: SkillPackage): string {
  const m = pkg.manifest;
  const scriptsPresent = Object.keys(pkg.scripts).length > 0;
  const lines = [
    emitFrontmatterLine('name', pkg.name),
    emitFrontmatterLine('description', pkg.description),
    emitFrontmatterLine('version', pkg.version),
    emitFrontmatterLine('author', pkg.author),
    emitFrontmatterLine('license', pkg.license),
    emitFrontmatterLine('tags', pkg.tags),
    emitFrontmatterLine('agents', pkg.agents),
    // allowed-tools is space-delimited in the standard.
    m.tools?.length ? `allowed-tools: ${m.tools.join(' ')}` : undefined,
    emitFrontmatterLine('network', m.network),
    emitFrontmatterLine('filesystem', m.filesystem),
    emitFrontmatterLine('secrets', m.secrets),
    // Only emit execution when it differs from the default (scripts present ⇒ execution).
    m.execution === false && scriptsPresent ? 'execution: false' : undefined,
    // Preserve any extra recognised-but-unmodelled keys so the round trip is lossless.
    ...Object.entries(pkg.metadata ?? {}).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean);
  return `---\n${lines.join('\n')}\n---\n\n${pkg.body}\n`;
}

/** Serialise a whole package folder (SKILL.md + bundled references/scripts) as a `{ path: contents }` map. */
export function exportSkillPackage(pkg: SkillPackage): Record<string, string> {
  return { 'SKILL.md': exportSkillMd(pkg), ...pkg.resources, ...pkg.scripts };
}

/**
 * Build a `SKILL.md` from a plain `SkillDefinition` (one that never came from a package). Lets you
 * publish an in-code skill out to the open standard.
 */
export function skillDefinitionToSkillMd(skill: SkillDefinition): string {
  const description = skill.whenToUse ? `${skill.summary} ${skill.whenToUse}` : skill.summary;
  const lines = [
    `name: ${skill.id}`,
    `description: ${description.replace(/\n/g, ' ')}`,
    emitFrontmatterLine('version', skill.version),
    emitFrontmatterLine('tags', skill.tags),
    skill.toolNames?.length ? `allowed-tools: ${skill.toolNames.join(' ')}` : undefined,
  ].filter(Boolean);
  const body = skill.executionGuidance ?? skill.instructions ?? skill.summary;
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
}

// ── Import ─────────────────────────────────────────────────────────────────────────────────────

export interface ImportSkillResult {
  readonly package: SkillPackage;
  /** A `SkillDefinition` bridged from the package, marked `lifecycle: 'draft'` (untrusted, unreviewed). */
  readonly definition: SkillDefinition;
  /** The full security assessment — imported skills are always scanned, always entering at tier T1. */
  readonly assessment: SkillAssessment;
}

export interface ImportSkillOptions {
  /** Enforce that the frontmatter `name` matches this folder name (agentskills.io rule). */
  readonly folderName?: string;
  /** Extra scan options (deep scan, size limits). `claimedTier` is forced to 1 and cannot be raised here. */
  readonly scan?: Omit<AssessOptions, 'claimedTier' | 'signature'>;
  /** Throw if the security scan blocks the skill, instead of returning the assessment. Default: false. */
  readonly rejectIfBlocked?: boolean;
}

/**
 * Import a `SKILL.md` (a raw string, or a `{ path: contents }` folder map) into a skill.
 *
 * Security: the skill ALWAYS enters at tier T1 and is ALWAYS run through the full gate scan — an
 * import is never trusted on arrival. The returned `assessment` tells you what was found; nothing is
 * enabled or promoted automatically. Malformed frontmatter throws a precise `SkillPackageError`.
 */
export async function importSkillMd(
  input: string | Readonly<Record<string, string>>,
  opts: ImportSkillOptions = {},
): Promise<ImportSkillResult> {
  const files = typeof input === 'string' ? { 'SKILL.md': input } : input;
  const pkg = parseSkillPackage(files, opts.folderName ? { folderName: opts.folderName } : undefined);

  // Always scan, always at the lowest tier — imported code is untrusted by default.
  const assessment = await assessSkillPackage(pkg, { ...opts.scan, claimedTier: 1 });
  if (opts.rejectIfBlocked && !assessment.allowed) {
    const blockers = assessment.findings.filter((f) => f.severity === 'block').map((f) => `${f.owasp ?? f.gate}: ${f.message}`);
    throw new Error(`imported skill "${pkg.name}" was blocked by the security scan:\n- ${blockers.join('\n- ')}`);
  }

  const definition: SkillDefinition = { ...skillPackageToDefinition(pkg), lifecycle: 'draft' };
  return { package: pkg, definition, assessment };
}

export interface DirectoryImportResult {
  readonly imported: readonly ImportSkillResult[];
  /** Folders that failed to parse, with the reason (never throws mid-batch). */
  readonly failed: ReadonlyArray<{ readonly folder: string; readonly error: string }>;
}

/**
 * Import a directory of many skill folders at once — `{ folderName: { path: contents } }`. A folder
 * that fails to parse is collected in `failed` rather than aborting the whole batch.
 */
export async function importSkillMdDirectory(
  folders: Readonly<Record<string, Readonly<Record<string, string>>>>,
  opts: Omit<ImportSkillOptions, 'folderName'> = {},
): Promise<DirectoryImportResult> {
  const imported: ImportSkillResult[] = [];
  const failed: Array<{ folder: string; error: string }> = [];
  for (const [folder, files] of Object.entries(folders)) {
    try {
      imported.push(await importSkillMd(files, { ...opts, folderName: folder }));
    } catch (e) {
      failed.push({ folder, error: (e as Error).message });
    }
  }
  return { imported, failed };
}
