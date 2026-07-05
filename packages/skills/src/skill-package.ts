// SPDX-License-Identifier: MIT
/**
 * Skill packages — the open `SKILL.md` folder format.
 *
 * Until now a skill was a row of text. A **skill package** is the richer, portable form the
 * ecosystem standardised on (agentskills.io): a folder with a `SKILL.md` file (a short YAML
 * header + Markdown instructions) plus optional bundled **reference files** and **runnable
 * scripts**. This lets a skill ship not just *advice* but the exact reference material and
 * deterministic code to do the job — loaded only when needed (see `skill-loader.ts`).
 *
 * This module is filesystem-agnostic: you hand it the already-read files as a
 * `{ path: contents }` map (read from disk, a blob store, or a zip in the app), and it parses,
 * validates, and classifies them. The engine never touches the filesystem itself.
 */

import { defineSkill } from './types.js';
import type { SkillDefinition } from './types.js';

/**
 * What a skill package declares it needs — its **least-privilege manifest**. A package should ask
 * for only what it genuinely uses (OWASP Agentic Skills AST03: excessive permissions). The security
 * gates (see `skill-security.ts`) check this against what the package's scripts actually try to do
 * and against the trust tier it's being installed at.
 */
export interface SkillCapabilityManifest {
  /** Hostnames the package is allowed to reach (empty/omitted = no network at all). */
  readonly network?: readonly string[];
  /** Path prefixes it may read/write (empty/omitted = the sandbox workspace only). */
  readonly filesystem?: readonly string[];
  /** Named secrets it may read (empty/omitted = none). */
  readonly secrets?: readonly string[];
  /** Tools it may call. */
  readonly tools?: readonly string[];
  /** Whether it runs bundled scripts at all. */
  readonly execution?: boolean;
}

export interface SkillPackage {
  /** lowercase-hyphen id; must match the folder name (agentskills.io rule). */
  readonly name: string;
  /** What it does AND when to use it (≤1024 chars). This is the Level-1 card. */
  readonly description: string;
  readonly version?: string;
  readonly author?: string;
  readonly license?: string;
  readonly tags?: readonly string[];
  readonly agents?: readonly string[];
  /** `allowed-tools` frontmatter — pre-approved tools (space-delimited in the file). */
  readonly allowedTools?: readonly string[];
  /** Any other recognised-but-unmodelled frontmatter keys (spec says: ignore, don't fail). */
  readonly metadata?: Readonly<Record<string, string>>;
  /** The Markdown body after the frontmatter — the Level-2 instructions. */
  readonly body: string;
  /** Bundled reference files (`references/*`, `assets/*`) — Level-3, path → contents. */
  readonly resources: Readonly<Record<string, string>>;
  /** Bundled runnable scripts (`scripts/*`) — Level-3, path → source. */
  readonly scripts: Readonly<Record<string, string>>;
  /** The least-privilege capability manifest declared in the frontmatter. */
  readonly manifest: SkillCapabilityManifest;
}

export class SkillPackageError extends Error {}

const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// A small, focused frontmatter reader for the SKILL.md subset (scalars + inline/block arrays).
// We deliberately do NOT pull a full YAML engine: the spec is a flat key/value header and
// unrecognised keys are ignored, so a tiny parser is safer and dependency-free.
function parseFrontmatter(md: string): { data: Record<string, string | string[]>; body: string } {
  if (!md.startsWith('---')) return { data: {}, body: md };
  const end = md.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: md };
  const header = md.slice(md.indexOf('\n') + 1, end);
  const body = md.slice(md.indexOf('\n', end + 1) + 1);
  const data: Record<string, string | string[]> = {};
  const lines = header.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if (val === '') {
      // block array: subsequent "  - item" lines
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) {
        items.push(lines[++i]!.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
      }
      if (items.length) data[key] = items;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      data[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { data, body };
}

const asArray = (v: string | string[] | undefined): string[] | undefined =>
  v == null ? undefined : Array.isArray(v) ? v : v.split(/\s+/).filter(Boolean);

/**
 * Parse an already-read skill folder (a `{ relativePath: contents }` map) into a `SkillPackage`.
 * `SKILL.md` is required. Files under `scripts/` become runnable scripts; files under
 * `references/` or `assets/` become resources. Throws `SkillPackageError` on an invalid header.
 */
export function parseSkillPackage(
  files: Readonly<Record<string, string>>,
  opts?: { folderName?: string },
): SkillPackage {
  const skillMd = files['SKILL.md'] ?? files['skill.md'];
  if (skillMd == null) throw new SkillPackageError('package is missing a SKILL.md file');

  const { data, body } = parseFrontmatter(skillMd);
  const name = typeof data['name'] === 'string' ? (data['name'] as string) : '';
  const description = typeof data['description'] === 'string' ? (data['description'] as string) : '';

  if (!name) throw new SkillPackageError('SKILL.md frontmatter is missing required field: name');
  if (!NAME_RE.test(name) || name.length > 64) {
    throw new SkillPackageError(`invalid skill name "${name}": lowercase letters, numbers and hyphens only, ≤64 chars, no leading/trailing hyphen`);
  }
  if (opts?.folderName && opts.folderName !== name) {
    throw new SkillPackageError(`skill name "${name}" must match its folder name "${opts.folderName}"`);
  }
  if (!description) throw new SkillPackageError('SKILL.md frontmatter is missing required field: description');
  if (description.length > 1024) throw new SkillPackageError('description exceeds 1024 characters');

  const resources: Record<string, string> = {};
  const scripts: Record<string, string> = {};
  const known = new Set([
    'name', 'description', 'version', 'author', 'license', 'tags', 'agents', 'allowed-tools',
    'network', 'filesystem', 'secrets', 'execution',
  ]);
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (!known.has(k) && typeof v === 'string') metadata[k] = v;

  for (const [path, contents] of Object.entries(files)) {
    if (path === 'SKILL.md' || path === 'skill.md') continue;
    if (path.startsWith('scripts/')) scripts[path] = contents;
    else if (path.startsWith('references/') || path.startsWith('assets/')) resources[path] = contents;
    else resources[path] = contents; // other bundled files are treated as (read-only) resources
  }

  const tools = asArray(data['allowed-tools']);
  const manifest: SkillCapabilityManifest = {
    network: asArray(data['network']),
    filesystem: asArray(data['filesystem']),
    secrets: asArray(data['secrets']),
    tools,
    // `execution: false` explicitly forbids scripts; otherwise it's implied by whether any exist.
    execution: data['execution'] === 'false' ? false : Object.keys(scripts).length > 0,
  };

  return {
    name,
    description,
    version: data['version'] as string | undefined,
    author: data['author'] as string | undefined,
    license: data['license'] as string | undefined,
    tags: asArray(data['tags']),
    agents: asArray(data['agents']),
    allowedTools: asArray(data['allowed-tools']),
    metadata: Object.keys(metadata).length ? metadata : undefined,
    body: body.trim(),
    resources,
    scripts,
    manifest,
  };
}

/**
 * Bridge a `SkillPackage` into a `SkillDefinition` so it flows through retrieval, activation,
 * and composition like any other skill. The description becomes the Level-1 card; the Markdown
 * body becomes the execution guidance (Level-2). Bundled scripts/resources stay in the package
 * and are reached on demand via the Level-3 loader.
 */
export function skillPackageToDefinition(pkg: SkillPackage): SkillDefinition {
  const firstSentence = pkg.description.split(/(?<=[.!?])\s/)[0] ?? pkg.description;
  return defineSkill({
    id: pkg.name,
    name: pkg.name,
    version: pkg.version,
    summary: firstSentence,
    whenToUse: pkg.description,
    executionGuidance: pkg.body || undefined,
    toolNames: pkg.allowedTools,
    tags: pkg.tags,
  });
}
