// SPDX-License-Identifier: MIT
/**
 * Skill composition graph — turn a flat set of selected skills into a safe, ordered plan.
 *
 * Real tasks need several skills working together ("load the data → analyse it → write the
 * report"). Left as a flat list, the model has to guess the order and might pick skills that
 * clash or that need something that isn't there yet. `resolveSkillGraph()` fixes that by
 * building a typed dependency graph and:
 *
 *   1. **Pulls in requirements.** If a selected skill `requires` another, that one is added
 *      automatically — with a safety rule: a skill can only pull in dependencies at its own
 *      privilege level or lower (no escalating by requiring something more powerful).
 *   2. **Detects cycles.** "A needs B needs A" is caught and reported instead of looping forever.
 *   3. **Resolves conflicts.** Two skills that are `conflictsWith` each other can't both run;
 *      the higher-trust / higher-priority one wins, the other is dropped with a reason.
 *   4. **Orders by readiness (topological).** A skill runs only after the skills it depends on,
 *      and only once the typed inputs it needs (its `precondition`) are available — either from
 *      the context you pass in, or produced (`provides`) by an earlier skill.
 *   5. **Defers what isn't ready.** Skills whose inputs can't be produced are set aside (with
 *      the exact missing tokens) rather than run blindly.
 *
 * This is a pure, deterministic function — no LLM, no I/O — so it's fast and easy to test.
 * Design intent (open-core): the *resolver* is the engine here; the *edges* (which skill
 * requires/conflicts/provides what) are authored in the app's catalog.
 */

import type { SkillDefinition } from './types.js';

export interface SkillGraphNode {
  readonly skill: SkillDefinition;
  /** Ids that must be ordered before this skill (its `requires` present in the resolved set). */
  readonly dependsOn: readonly string[];
  /** Whether this skill's precondition tokens were all available at its position. */
  readonly feasible: boolean;
}

export interface SkillGraphResult {
  /** Topologically ordered, feasible skills — run them in this order. */
  readonly ordered: readonly SkillDefinition[];
  readonly nodes: readonly SkillGraphNode[];
  /** Dependency skill ids that were auto-pulled in (were not in the original selection). */
  readonly added: readonly string[];
  /** Skills removed, with why (conflict lost / trust escalation / missing dependency / over budget). */
  readonly dropped: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  /** Skills whose typed inputs could never be satisfied — set aside with the missing tokens. */
  readonly deferred: ReadonlyArray<{ readonly id: string; readonly missing: readonly string[] }>;
  /** A `requires` cycle path, if one was detected (e.g. ['a','b','a']). */
  readonly cycle?: readonly string[];
}

export interface SkillGraphOptions {
  /** Capability tokens already available in the context (the starting "frontier"). */
  readonly availableCapabilities?: readonly string[];
  /** Max total skills in the resolved set (guards against runaway dependency fan-out). Default 50. */
  readonly maxSkills?: number;
  /** Max depth of a `requires` chain to follow. Default 16. */
  readonly maxDepth?: number;
  /** Also pull in `composesWith` suggestions when the partner is already enabled in the catalog. Default false. */
  readonly includeComposesWith?: boolean;
  /**
   * Conflict tie-break: given two skills that conflict, return the one to KEEP.
   * Default: higher `trust`, then higher `priority`, then stable by id.
   */
  readonly resolveConflict?: (a: SkillDefinition, b: SkillDefinition) => SkillDefinition;
}

const trustOf = (s: SkillDefinition): number => s.trust ?? 0;
const priorityOf = (s: SkillDefinition): number => s.priority ?? 0;

function defaultResolveConflict(a: SkillDefinition, b: SkillDefinition): SkillDefinition {
  if (trustOf(a) !== trustOf(b)) return trustOf(a) > trustOf(b) ? a : b;
  if (priorityOf(a) !== priorityOf(b)) return priorityOf(a) > priorityOf(b) ? a : b;
  return a.id <= b.id ? a : b;
}

/** Detect a cycle in the `requires` graph over the given skills. Returns the cycle path or null. */
export function detectRequiresCycle(skills: readonly SkillDefinition[]): string[] | null {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen(implicit) 1=in-stack 2=done
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    const s = byId.get(id);
    if (!s) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dep of s.requires ?? []) {
      if (!byId.has(dep)) continue;
      const st = state.get(dep) ?? 0;
      if (st === 1) {
        // back-edge → cycle; return the path from `dep` around to here.
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (st === 0) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  }

  for (const s of skills) {
    if ((state.get(s.id) ?? 0) === 0) {
      const found = dfs(s.id);
      if (found) return found;
    }
  }
  return null;
}

export function resolveSkillGraph(
  selected: readonly SkillDefinition[],
  catalog: readonly SkillDefinition[],
  opts: SkillGraphOptions = {},
): SkillGraphResult {
  const maxSkills = opts.maxSkills ?? 50;
  const maxDepth = opts.maxDepth ?? 16;
  const resolveConflict = opts.resolveConflict ?? defaultResolveConflict;
  const catalogById = new Map(catalog.map((s) => [s.id, s]));
  const dropped: Array<{ id: string; reason: string }> = [];
  const added: string[] = [];

  // ── 1. Expand `requires` (and optional `composesWith`), trust-gated, depth+size bounded ──
  const resolved = new Map<string, SkillDefinition>();
  const queue: Array<{ id: string; depth: number }> = [];
  for (const s of selected) if (s.enabled !== false) { resolved.set(s.id, s); queue.push({ id: s.id, depth: 0 }); }

  while (queue.length) {
    const { id, depth } = queue.shift()!;
    const skill = resolved.get(id);
    if (!skill || depth >= maxDepth) continue;
    const deps = [
      ...(skill.requires ?? []),
      ...(opts.includeComposesWith ? skill.composesWith ?? [] : []),
    ];
    for (const depId of deps) {
      if (resolved.has(depId)) continue;
      const dep = catalogById.get(depId);
      if (!dep || dep.enabled === false) {
        if ((skill.requires ?? []).includes(depId)) dropped.push({ id, reason: `requires missing/disabled skill "${depId}"` });
        continue;
      }
      // Security: a skill cannot pull in a dependency more privileged than itself.
      if (trustOf(dep) > trustOf(skill)) {
        dropped.push({ id: dep.id, reason: `dependency trust escalation blocked ("${id}" trust ${trustOf(skill)} < "${dep.id}" trust ${trustOf(dep)})` });
        continue;
      }
      if (resolved.size >= maxSkills) {
        dropped.push({ id: depId, reason: `resolved-set size limit (${maxSkills}) reached` });
        continue;
      }
      resolved.set(dep.id, dep);
      added.push(dep.id);
      queue.push({ id: dep.id, depth: depth + 1 });
    }
  }

  // ── 2. Cycle detection (over the resolved set) ──
  const cycle = detectRequiresCycle([...resolved.values()]) ?? undefined;

  // ── 3. Conflict resolution ──
  // If two resolved skills declare each other (or one declares the other) as a conflict, keep one.
  for (const a of [...resolved.values()]) {
    if (!resolved.has(a.id)) continue;
    for (const otherId of a.conflictsWith ?? []) {
      const b = resolved.get(otherId);
      if (!b) continue;
      const keep = resolveConflict(a, b);
      const drop = keep.id === a.id ? b : a;
      resolved.delete(drop.id);
      dropped.push({ id: drop.id, reason: `conflicts with "${keep.id}" (kept higher trust/priority)` });
      if (drop.id === a.id) break; // a itself was dropped — stop scanning its conflicts
    }
  }

  // ── 4. Topological order by readiness (requires + provides→precondition), SCALAR-style frontier ──
  const remaining = new Map(resolved);
  const available = new Set(opts.availableCapabilities ?? []);
  const orderedIds = new Set<string>();
  const ordered: SkillDefinition[] = [];

  const requiresSatisfied = (s: SkillDefinition): boolean =>
    (s.requires ?? []).every((r) => !remaining.has(r) /* dropped */ ? true : orderedIds.has(r));
  const preconditionMet = (s: SkillDefinition): boolean =>
    (s.precondition?.requires ?? []).every((t) => available.has(t));

  for (;;) {
    // Deterministic pick order among ready skills: priority desc, then id.
    const ready = [...remaining.values()]
      .filter((s) => requiresSatisfied(s) && preconditionMet(s))
      .sort((x, y) => priorityOf(y) - priorityOf(x) || (x.id < y.id ? -1 : 1));
    if (!ready.length) break;
    for (const s of ready) {
      remaining.delete(s.id);
      orderedIds.add(s.id);
      ordered.push(s);
      for (const t of s.provides ?? []) available.add(t);
    }
  }

  // ── 5. Whatever is left couldn't be made ready — defer it with the missing tokens ──
  const deferred = [...remaining.values()].map((s) => ({
    id: s.id,
    missing: [
      ...(s.precondition?.requires ?? []).filter((t) => !available.has(t)),
      ...(s.requires ?? []).filter((r) => remaining.has(r) || (!orderedIds.has(r) && resolved.has(r))),
    ],
  }));

  const nodes: SkillGraphNode[] = ordered.map((s) => ({
    skill: s,
    dependsOn: (s.requires ?? []).filter((r) => orderedIds.has(r)),
    feasible: true,
  }));

  return { ordered, nodes, added, dropped, deferred, cycle };
}

/**
 * Is a skill's declared work complete, given the capabilities now available and how many
 * passes it has run? Lets a composing runtime know when to stop.
 */
export function isSkillTerminated(
  skill: SkillDefinition,
  availableCapabilities: readonly string[],
  iterations = 0,
): boolean {
  const term = skill.termination;
  if (!term) return false;
  if (term.maxIterations != null && iterations >= term.maxIterations) return true;
  if (term.satisfiedWhen?.length) {
    const have = new Set(availableCapabilities);
    return term.satisfiedWhen.every((t) => have.has(t));
  }
  return false;
}
