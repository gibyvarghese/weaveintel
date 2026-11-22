// SPDX-License-Identifier: MIT
/**
 * @weaveintel/agents — swarm: checking a definition, and the estimate a person
 * is shown before a swarm starts. Pure code; no model is called here.
 */

import {
  SWARM_APPROVAL_POINTS,
  SWARM_JOIN_KINDS,
  SWARM_KEY_RULE,
  SWARM_PATTERNS,
  SWARM_ROLE_KINDS,
  SWARM_TOOL_NAME_RULE,
  type SwarmDefinition,
  type SwarmEstimate,
  type SwarmRole,
  type SwarmStartInput,
} from './types.js';

export interface SwarmValidation {
  readonly ok: boolean;
  /** Every problem, in words a person can act on. */
  readonly errors: readonly string[];
}

/** Thrown by the engine when it is handed a definition it will not run. */
export class SwarmDefinitionError extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(`Swarm definition is not valid: ${errors.join('; ')}`);
    this.name = 'SwarmDefinitionError';
    this.errors = errors;
  }
}

const positiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export function roleOf(def: SwarmDefinition, key: string | undefined): SwarmRole | undefined {
  return key === undefined ? undefined : def.roles.find((r) => r.key === key);
}

/**
 * Check a definition. Returns every problem rather than the first, so a
 * person fixing rows sees the whole list.
 */
export function validateSwarmDefinition(def: SwarmDefinition): SwarmValidation {
  const errors: string[] = [];
  const say = (m: string): void => { errors.push(m); };

  if (!SWARM_KEY_RULE.test(def.key ?? '')) say(`swarm key "${String(def.key)}" must match ${String(SWARM_KEY_RULE)}`);
  if (typeof def.goalTemplate !== 'string' || def.goalTemplate.trim() === '') say('the goal is empty');
  if (!SWARM_PATTERNS.includes(def.pattern)) say(`pattern "${String(def.pattern)}" is not one of ${SWARM_PATTERNS.join(', ')}`);

  // Limits: all present, all positive. A missing limit is an error, never "unlimited".
  const l = def.limits ?? ({} as SwarmDefinition['limits']);
  if (!positiveInt(l.maxAgents)) say('limits.maxAgents must be a whole number above zero');
  if (!positiveInt(l.maxConcurrency)) say('limits.maxConcurrency must be a whole number above zero');
  if (!positiveInt(l.maxStepsPerAgent)) say('limits.maxStepsPerAgent must be a whole number above zero');
  if (!(typeof l.maxWallClockMs === 'number' && l.maxWallClockMs > 0)) say('limits.maxWallClockMs must be above zero');
  if (l.maxTotalTokens !== undefined && !positiveInt(l.maxTotalTokens)) say('limits.maxTotalTokens must be a whole number above zero');
  if (l.maxCostUsd !== undefined && !(typeof l.maxCostUsd === 'number' && l.maxCostUsd > 0)) say('limits.maxCostUsd must be above zero');
  if (l.maxModelCalls !== undefined && !positiveInt(l.maxModelCalls)) say('limits.maxModelCalls must be a whole number above zero');

  // Roles.
  const roles = def.roles ?? [];
  const seen = new Set<string>();
  const writeTools = new Set(def.writeTools ?? []);
  for (const r of roles) {
    if (!SWARM_KEY_RULE.test(r.key ?? '')) say(`role key "${String(r.key)}" must match ${String(SWARM_KEY_RULE)}`);
    if (seen.has(r.key)) say(`role "${r.key}" is defined twice`);
    seen.add(r.key);
    if (!SWARM_ROLE_KINDS.includes(r.kind)) say(`role "${r.key}" has kind "${String(r.kind)}", not one of ${SWARM_ROLE_KINDS.join(', ')}`);
    const hasPrompt = typeof r.prompt === 'string' && r.prompt.trim() !== '';
    const hasRef = typeof r.promptRef === 'string' && r.promptRef.trim() !== '';
    if (!hasPrompt && !hasRef) say(`role "${r.key}" has no brief (prompt or promptRef)`);
    if (typeof r.modelPurpose !== 'string' || r.modelPurpose.trim() === '') say(`role "${r.key}" does not say which model purpose it needs`);
    if (r.maxSteps !== undefined) {
      if (!positiveInt(r.maxSteps)) say(`role "${r.key}" maxSteps must be a whole number above zero`);
      else if (positiveInt(l.maxStepsPerAgent) && r.maxSteps > l.maxStepsPerAgent) say(`role "${r.key}" asks for ${r.maxSteps} steps, above the limit of ${l.maxStepsPerAgent}`);
    }
    const toolSeen = new Set<string>();
    for (const t of r.tools ?? []) {
      // The name rule every provider enforces: a dotted name is a 400 at the first call.
      if (!SWARM_TOOL_NAME_RULE.test(t)) say(`role "${r.key}" lists tool "${t}", which does not match ${String(SWARM_TOOL_NAME_RULE)}`);
      if (toolSeen.has(t)) say(`role "${r.key}" lists tool "${t}" twice`);
      toolSeen.add(t);
    }
    // The supervisor trap: a lead that holds a direct tool answers with it and never delegates.
    if (r.kind === 'lead' && (r.tools ?? []).length > 0) say(`lead role "${r.key}" holds tools; a lead that can act itself does not delegate, so give the tools to its helpers`);
    if (r.kind === 'planner' && (r.tools ?? []).length > 0) say(`planner role "${r.key}" holds tools; a planner only plans`);
  }
  for (const w of writeTools) {
    if (!SWARM_TOOL_NAME_RULE.test(w)) say(`write tool "${w}" does not match ${String(SWARM_TOOL_NAME_RULE)}`);
    if (!roles.some((r) => (r.tools ?? []).includes(w))) say(`write tool "${w}" is named but no role uses it`);
  }

  const need = (key: string | undefined, kind: SwarmRole['kind'], what: string): void => {
    if (key === undefined || key === '') { say(`${what} names no role`); return; }
    const r = roles.find((x) => x.key === key);
    if (!r) say(`${what} names role "${key}", which is not defined`);
    else if (r.kind !== kind) say(`${what} names role "${key}", which is a ${r.kind}, not a ${kind}`);
  };

  // Approval points.
  for (const p of def.approvalPoints ?? []) {
    if (!SWARM_APPROVAL_POINTS.includes(p)) say(`approval point "${String(p)}" is not one of ${SWARM_APPROVAL_POINTS.join(', ')}`);
  }

  // Failure handling.
  const f = def.onFailure ?? ({} as SwarmDefinition['onFailure']);
  if (f.worker !== 'continue' && f.worker !== 'fail_run') say('onFailure.worker must be "continue" or "fail_run"');
  if (!(Number.isInteger(f.maxRetriesPerTask) && f.maxRetriesPerTask >= 0 && f.maxRetriesPerTask <= 3)) say('onFailure.maxRetriesPerTask must be a whole number from 0 to 3');
  if (f.minWorkersOk !== undefined && !positiveInt(f.minWorkersOk)) say('onFailure.minWorkersOk must be a whole number above zero');

  // Join.
  const join = def.join ?? ({} as SwarmDefinition['join']);
  if (!SWARM_JOIN_KINDS.includes(join.kind)) say(`join "${String(join.kind)}" is not one of ${SWARM_JOIN_KINDS.join(', ')}`);
  if (join.kind === 'reducer') need(join.role, 'reducer', 'the join');
  if (join.kind === 'judge_pick' || join.kind === 'judge_merge') need(join.role, 'judge', 'the join');
  if (def.checker) need(def.checker.role, 'checker', 'the checker');

  // Pattern parts.
  const ts = def.taskSource;
  switch (def.pattern) {
    case 'plan_fan_out_join': {
      if (!ts || (ts.kind !== 'planner' && ts.kind !== 'fixed')) say('plan_fan_out_join needs a task list from a planner or a fixed list');
      if (join.kind !== 'reducer') say('plan_fan_out_join joins with a reducer');
      break;
    }
    case 'map_reduce': {
      if (!ts || ts.kind !== 'per_item') say('map_reduce needs one task per input item (taskSource per_item)');
      if (join.kind !== 'reducer') say('map_reduce joins with a reducer');
      break;
    }
    case 'pipeline': {
      const stages = def.stages ?? [];
      if (stages.length < 2) say('pipeline needs at least two stages');
      for (const s of stages) need(s, 'worker', 'a pipeline stage');
      if (join.kind !== 'last_stage') say('pipeline joins with its last stage (join last_stage)');
      break;
    }
    case 'attempts_judge': {
      if (!ts || ts.kind !== 'fixed' || ts.tasks.length !== 1) say('attempts_judge needs a fixed task list with exactly one task (the brief every attempt gets)');
      if (join.kind !== 'judge_pick' && join.kind !== 'judge_merge') say('attempts_judge joins with a judge (judge_pick or judge_merge)');
      const n = def.attempts ?? 3;
      if (!(Number.isInteger(n) && n >= 2)) say('attempts_judge needs at least two attempts');
      break;
    }
    case 'lead_helpers': {
      const leads = roles.filter((r) => r.kind === 'lead');
      if (leads.length !== 1) say('lead_helpers needs exactly one lead role');
      if (!roles.some((r) => r.kind === 'worker')) say('lead_helpers needs at least one helper (a worker role)');
      if (join.kind !== 'lead') say('lead_helpers joins with the lead (join lead)');
      break;
    }
    default: break;
  }
  if (ts) {
    if (ts.kind === 'planner') {
      need(ts.role, 'planner', 'the task list');
      if (!roles.some((r) => r.kind === 'worker')) say('a planner needs at least one worker role to give tasks to');
      if (ts.maxTasks !== undefined && !positiveInt(ts.maxTasks)) say('taskSource.maxTasks must be a whole number above zero');
      if (ts.maxTaskChars !== undefined && !positiveInt(ts.maxTaskChars)) say('taskSource.maxTaskChars must be a whole number above zero');
    } else if (ts.kind === 'fixed') {
      if (ts.tasks.length === 0) say('the fixed task list is empty');
      const keys = new Set<string>();
      for (const t of ts.tasks) {
        if (!SWARM_KEY_RULE.test(t.key ?? '')) say(`task key "${String(t.key)}" must match ${String(SWARM_KEY_RULE)}`);
        if ((t.key ?? '').startsWith('swarm_')) say(`task key "${t.key}" starts with "swarm_", which the engine keeps for its own agents`);
        if (keys.has(t.key)) say(`task "${t.key}" is listed twice`);
        keys.add(t.key);
        if (typeof t.title !== 'string' || t.title.trim() === '') say(`task "${t.key}" has no title`);
        need(t.role, 'worker', `task "${t.key}"`);
      }
    } else if (ts.kind === 'per_item') {
      need(ts.role, 'worker', 'the per-item task list');
      if (ts.maxItems !== undefined && !positiveInt(ts.maxItems)) say('taskSource.maxItems must be a whole number above zero');
    }
  }

  return { ok: errors.length === 0, errors };
}

/** How many agent runs a role outside the worker pool adds (planner, reducer, judge, checker). */
function overheadAgents(def: SwarmDefinition): number {
  let n = 0;
  if (def.taskSource?.kind === 'planner') n += 1;
  if (def.join.kind === 'reducer' || def.join.kind === 'judge_pick' || def.join.kind === 'judge_merge') n += 1;
  if (def.checker) n += 1;
  return n;
}

/**
 * What a person is shown before a swarm starts: about how many agents, the
 * caps, whether it only reads. Worked out from the definition and the input;
 * it calls no model and costs nothing.
 */
export function estimateSwarm(def: SwarmDefinition, input?: Pick<SwarmStartInput, 'items'>): SwarmEstimate {
  const over = overheadAgents(def);
  const cap = def.limits.maxAgents;
  let min = 1;
  let max = cap;
  const ts = def.taskSource;
  switch (def.pattern) {
    case 'plan_fan_out_join':
      if (ts?.kind === 'fixed') { min = ts.tasks.length + over; max = min; }
      else if (ts?.kind === 'planner') { min = 1 + over; max = Math.min(cap, (ts.maxTasks ?? cap) + over); }
      break;
    case 'map_reduce': {
      const items = input?.items?.length;
      const perItemCap = ts?.kind === 'per_item' ? (ts.maxItems ?? cap) : cap;
      if (items !== undefined) { min = Math.min(items, perItemCap) + over; max = min; }
      else { min = 1 + over; max = Math.min(cap, perItemCap + over); }
      break;
    }
    case 'pipeline': min = (def.stages?.length ?? 0) + over; max = min; break;
    case 'attempts_judge': min = (def.attempts ?? 3) + over; max = min; break;
    case 'lead_helpers': min = 2 + over; max = cap; break;
    default: break;
  }
  min = Math.min(min, cap);
  max = Math.min(Math.max(max, min), cap);
  const working = def.roles.filter((r) => r.kind !== 'planner' || ts?.kind === 'planner');
  const writeTools = [...(def.writeTools ?? [])];
  return {
    pattern: def.pattern,
    agentsMin: min,
    agentsMax: max,
    maxConcurrency: def.limits.maxConcurrency,
    modelCallsMax: def.limits.maxModelCalls ?? max * def.limits.maxStepsPerAgent,
    ...(def.limits.maxCostUsd !== undefined ? { costCapUsd: def.limits.maxCostUsd } : {}),
    wallClockCapMs: def.limits.maxWallClockMs,
    readsOnly: writeTools.length === 0,
    writeTools,
    approvalPoints: [...def.approvalPoints],
    roles: working.map((r) => ({ key: r.key, kind: r.kind, label: r.label ?? r.key, tools: [...r.tools] })),
  };
}
