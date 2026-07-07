// SPDX-License-Identifier: MIT
/**
 * Three-level progressive disclosure for skill packages.
 *
 * Loading a whole skill folder into every prompt would be wasteful and slow. The open Agent-Skills
 * standard (agentskills.io) uses **three levels**, and this module implements them:
 *
 *   • Level 1 — the *card* (name + description). Tiny, always in context, lets the model decide
 *     whether the skill is even relevant.
 *   • Level 2 — the *body* (the Markdown instructions). Loaded only once a skill is chosen.
 *   • Level 3 — the *bundled files*. Reference material (`references/`, `assets/`) is read only when
 *     the task needs it, and bundled *scripts* (`scripts/`) are run — never in this process, but
 *     handed to a **sandbox you inject** (typically `@weaveintel/sandbox`, Docker/microVM-isolated).
 *
 * Why inject the sandbox rather than import it? So this package stays light and the *app* stays in
 * charge of the isolation policy (which container image, what egress rules) — the open-core boundary.
 * The engine's job is to enforce the *safe defaults* around whatever runner it's given: deny network
 * egress unless explicitly asked for, block path traversal, cap how many scripts run at once, and
 * refuse to run anything without a real sandbox.
 */

import type { SkillPackage } from './skill-package.js';
import type { SkillDefinition } from './types.js';

// ── Level 1 & 2 ──────────────────────────────────────────────────────────────────────────────

/** Level 1: the always-loaded card the model sees for every skill (name + when-to-use). */
export function skillCardL1(pkg: SkillPackage): string {
  return `${pkg.name}: ${pkg.description}`;
}

/** Level 2: the full instructions, loaded only once a skill is activated. */
export function skillBodyL2(pkg: SkillPackage): string {
  return pkg.body;
}

/** List the Level-3 files an agent may open or run for this skill. */
export function listSkillFiles(pkg: SkillPackage): { readonly resources: string[]; readonly scripts: string[] } {
  return { resources: Object.keys(pkg.resources).sort(), scripts: Object.keys(pkg.scripts).sort() };
}

// ── Level 3: reading bundled files ───────────────────────────────────────────────────────────

export class SkillResourceError extends Error {}

// Reject anything that could escape the package: parent traversal, absolute paths, or a NUL byte.
// Because files live in a `{ path: contents }` map, an out-of-package path simply isn't a key — but
// we reject it explicitly so the *reason* is a clear security error, not a vague "not found".
function assertSafePath(path: string): void {
  if (!path || path.includes('\0')) throw new SkillResourceError('invalid resource path');
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) throw new SkillResourceError(`absolute paths are not allowed: ${path}`);
  const parts = path.split(/[\\/]/);
  if (parts.some((p) => p === '..')) throw new SkillResourceError(`path traversal is not allowed: ${path}`);
}

/**
 * Level 3 (read): return the contents of a bundled reference or script file.
 * Throws `SkillResourceError` for a missing file or an unsafe path — never reads outside the package.
 */
export function readSkillFile(pkg: SkillPackage, path: string): string {
  assertSafePath(path);
  const contents = pkg.resources[path] ?? pkg.scripts[path];
  if (contents == null) throw new SkillResourceError(`resource not found in skill "${pkg.name}": ${path}`);
  return contents;
}

// ── Level 3: running bundled scripts (through an injected sandbox) ────────────────────────────

/** What a bundled script run looks like to the sandbox. Mirrors `@weaveintel/sandbox`'s CSE request. */
export interface SkillScriptRunSpec {
  readonly language: string;
  /** The script source. */
  readonly code: string;
  /** Extra files placed in the sandbox workspace alongside the script (e.g. bundled data). */
  readonly files?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  /** Whether outbound network is permitted at all. The engine defaults this to `false` (deny egress). */
  readonly networkAccess?: boolean;
  /**
   * The exact hosts the script is allowed to reach — the skill's declared `network` manifest. A runner
   * that supports per-host egress (an egress proxy / kernel allowlist, per the NVIDIA/OWASP model)
   * should permit ONLY these hosts and drop everything else; a boolean-only runner treats a non-empty
   * list as "network on". Empty/omitted + `networkAccess:false` = deny all egress (the default).
   */
  readonly networkAllowlist?: readonly string[];
}

export interface SkillScriptResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut?: boolean;
}

/**
 * The sandbox seam. Implement this over `@weaveintel/sandbox` (its CSE `run(...)` maps almost 1:1)
 * or any other isolated executor. The engine only ever talks to a skill script through this.
 */
export interface SkillScriptRunner {
  run(spec: SkillScriptRunSpec): Promise<SkillScriptResult>;
}

const LANG_BY_EXT: Record<string, string> = {
  py: 'python', python: 'python', sh: 'bash', bash: 'bash',
  js: 'node', mjs: 'node', cjs: 'node', ts: 'node', rb: 'ruby',
};

/** Infer the language for the sandbox from a script's file extension. */
export function inferSkillScriptLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXT[ext] ?? 'bash';
}

export interface RunSkillScriptOptions {
  readonly pkg: SkillPackage;
  /** A `scripts/*` path inside the package. */
  readonly path: string;
  /** The injected sandbox. Required — the engine refuses to run a script without one. */
  readonly runner: SkillScriptRunner;
  readonly args?: readonly string[];
  /**
   * Opt in to outbound network for this run. Default `false` (deny egress). The engine will only
   * pass `true` through if the skill's own `allowed-tools` frontmatter declares a network need —
   * so a caller can't grant a package more reach than it asked for.
   */
  readonly allowNetwork?: boolean;
  readonly timeoutMs?: number;
  /** Extra runtime files (e.g. the user's data) to place beside the script. */
  readonly inputFiles?: Readonly<Record<string, string>>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The hosts a package is *authoritatively* allowed to reach — its `network` manifest, declared in the
 * SKILL.md frontmatter. This is the single source of truth (the same list the security gates validate
 * a script's observed egress against), replacing the old, fragile "does an allowed-tool name contain
 * 'web'?" guess. No declared hosts ⇒ no network.
 */
function declaredNetworkHosts(pkg: SkillPackage): readonly string[] {
  return pkg.manifest.network ?? [];
}

/**
 * Level 3 (run): execute a bundled script in the injected sandbox, with self-enforcing safe defaults —
 * so the engine is safe even if the app never ran the install-time security gates (defense in depth).
 *
 * Guarantees, regardless of the runner:
 *   • a package whose manifest declares `execution: false` is refused outright;
 *   • only a `scripts/*` file of THIS package can be run (no traversal, no arbitrary path);
 *   • network egress is denied unless the caller opts in AND the package's manifest declares hosts —
 *     and the declared host allowlist is passed to the runner so a proxy-capable sandbox restricts
 *     egress to exactly those hosts (least privilege);
 *   • the package's own reference files are made available to the script, plus any input files;
 *   • a wall-clock timeout is always set.
 */
export async function runSkillScript(opts: RunSkillScriptOptions): Promise<SkillScriptResult> {
  const { pkg, path, runner } = opts;
  if (!runner || typeof runner.run !== 'function') {
    throw new SkillResourceError('cannot run a skill script without a sandbox runner (refusing host execution)');
  }
  // Honour the least-privilege manifest at runtime, not just at install time: a package that declares
  // it does not execute code must never have a bundled script run (OWASP Agentic Skills AST10).
  if (pkg.manifest.execution === false) {
    throw new SkillResourceError(`skill "${pkg.name}" declares execution: false — running its bundled scripts is not allowed`);
  }
  assertSafePath(path);
  const code = pkg.scripts[path];
  if (code == null) {
    // Reading a resource as if it were a script is a common mistake — be explicit.
    if (pkg.resources[path] != null) throw new SkillResourceError(`"${path}" is a reference file, not a runnable script`);
    throw new SkillResourceError(`script not found in skill "${pkg.name}": ${path}`);
  }

  // Network is off unless the caller opts in AND the manifest declares hosts. The declared hosts (and
  // only those) become the egress allowlist — a caller can never grant more reach than the skill asked.
  const hosts = declaredNetworkHosts(pkg);
  const networkAccess = opts.allowNetwork === true && hosts.length > 0;

  // Bundled reference files + caller input files become the script's workspace (script excluded).
  const files: Record<string, string> = {};
  for (const [p, c] of Object.entries(pkg.resources)) files[p] = c;
  for (const [p, c] of Object.entries(opts.inputFiles ?? {})) files[p] = c;

  return runner.run({
    language: inferSkillScriptLanguage(path),
    code,
    files,
    args: opts.args,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    networkAccess,
    networkAllowlist: networkAccess ? hosts : [],
  });
}

/**
 * Wrap a runner so at most `maxConcurrent` scripts execute at once; the rest queue. Containers are
 * heavy — this keeps a burst of script calls from exhausting host resources. Reuse a durable limiter
 * from `@weaveintel/resilience` for cross-process caps; this in-process guard covers a single node.
 */
export function limitScriptConcurrency(runner: SkillScriptRunner, maxConcurrent: number): SkillScriptRunner {
  if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < maxConcurrent) { active++; resolve(); }
      else queue.push(() => { active++; resolve(); });
    });
  const release = () => { active--; queue.shift()?.(); };
  return {
    async run(spec) {
      await acquire();
      try { return await runner.run(spec); }
      finally { release(); }
    },
  };
}

// ── Level 3 as agent tools ───────────────────────────────────────────────────────────────────

/** A minimal, framework-agnostic tool descriptor the app can register with its agent runtime. */
export interface SkillFileTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(args: Record<string, unknown>): Promise<string>;
}

/**
 * Build the two Level-3 tools an agent can call for an *active* skill package:
 * `read_skill_file` (open a bundled reference) and, if a sandbox is provided, `run_skill_script`
 * (run a bundled script safely). Omit the runner to expose read-only access.
 */
export function skillFileTools(pkg: SkillPackage, runner?: SkillScriptRunner): SkillFileTool[] {
  const files = listSkillFiles(pkg);
  const tools: SkillFileTool[] = [
    {
      name: 'read_skill_file',
      description: `Read a bundled reference file for the "${pkg.name}" skill. Available: ${files.resources.join(', ') || '(none)'}.`,
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'A references/* or assets/* path.' } }, required: ['path'] },
      async execute(args) {
        return readSkillFile(pkg, String(args['path'] ?? ''));
      },
    },
  ];
  // Only offer the run tool if the package actually permits execution — a manifest that says
  // `execution: false` shouldn't advertise a "run" affordance at all (and runSkillScript would refuse).
  if (runner && pkg.manifest.execution !== false && files.scripts.length > 0) {
    tools.push({
      name: 'run_skill_script',
      description: `Run a bundled script for the "${pkg.name}" skill in an isolated sandbox. Available: ${files.scripts.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'A scripts/* path.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments.' },
        },
        required: ['path'],
      },
      async execute(args) {
        const r = await runSkillScript({
          pkg,
          path: String(args['path'] ?? ''),
          runner,
          args: Array.isArray(args['args']) ? (args['args'] as string[]) : undefined,
        });
        return JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut ?? false });
      },
    });
  }
  return tools;
}

// ── Reaching a package (and its Level-3 tools) from an activated skill ─────────────────────────

/**
 * A lookup from skill id → its `SkillPackage`, so after `activateSkills()` returns `SkillDefinition`s
 * you can build the Level-3 file tools for the ones that came from packages — without threading the
 * packages through activation yourself. This closes the loop: retrieve → activate → open/run files.
 */
export interface SkillPackageIndex {
  /** The package for a skill id, if any. */
  get(name: string): SkillPackage | undefined;
  /** Every package in the index. */
  all(): SkillPackage[];
  /**
   * Build the Level-3 file tools for a skill. Accepts a skill id, an activated `SkillDefinition`
   * (uses its `package` pointer), or a `SkillPackage` directly. Returns `[]` for a skill that has no
   * package here (a plain text skill) — so you can call it unconditionally over all activated skills.
   */
  toolsFor(skill: string | SkillDefinition | SkillPackage, runner?: SkillScriptRunner): SkillFileTool[];
}

/** Build a `SkillPackageIndex` over the app's known skill packages. */
export function createSkillPackageIndex(packages: readonly SkillPackage[]): SkillPackageIndex {
  const byName = new Map<string, SkillPackage>();
  for (const p of packages) byName.set(p.name, p);
  const resolve = (skill: string | SkillDefinition | SkillPackage): SkillPackage | undefined => {
    if (typeof skill === 'string') return byName.get(skill);
    if ('body' in skill && 'scripts' in skill) return byName.get((skill as SkillPackage).name); // a SkillPackage
    return byName.get((skill as SkillDefinition).package?.name ?? ''); // a SkillDefinition — only if package-derived
  };
  return {
    get: (name) => byName.get(name),
    all: () => [...byName.values()],
    toolsFor: (skill, runner) => {
      const pkg = resolve(skill);
      return pkg ? skillFileTools(pkg, runner) : [];
    },
  };
}
