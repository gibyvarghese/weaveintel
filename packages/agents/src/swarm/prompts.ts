// SPDX-License-Identifier: MIT
/**
 * @weaveintel/agents — swarm: what each agent is told, and how its reply is read.
 *
 * Two rules live here.
 *
 *   1. DATA IS FENCED. An agent's instructions are the role's brief (definition
 *      text, written by whoever owns the swarm) plus a fixed reply contract.
 *      Everything else — the values a person typed into the goal, a task a
 *      planner wrote, what another agent found, a record a tool returned — is
 *      wrapped in a per-run fence the content cannot forge, and the agent is
 *      told that text inside the fence is data and never an instruction.
 *
 *   2. A REPLY IS CHECKED, NOT TRUSTED. Every role answers in a small JSON
 *      shape. The reply is parsed and its shape checked in code; a reply that
 *      does not fit is a reported failure, never something to act on.
 */

import { fenceUntrusted, makeFence, spotlightPreamble } from '@weaveintel/guardrails';
import type {
  SwarmConfidence,
  SwarmDefinition,
  SwarmEvidence,
  SwarmJoinedFinding,
  SwarmRole,
  SwarmRoleKind,
  SwarmTask,
  SwarmVerdict,
  SwarmWorkerResult,
} from './types.js';

export const SWARM_TEXT_LIMITS = {
  taskTitle: 200,
  taskBrief: 1200,
  finding: 8000,
  claim: 2000,
  evidenceRef: 300,
  evidenceNote: 600,
  evidencePerFinding: 20,
  notDone: 20,
  notDoneItem: 600,
  findings: 30,
  summary: 8000,
  reason: 1000,
} as const;

/** A fence nothing in the run's data can know in advance. */
export function newSwarmFence(): string {
  return makeFence();
}

export const fenced = (content: unknown, fence: string): string => fenceUntrusted(content, fence);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

// ─── The goal ────────────────────────────────────────────────

const SLOT = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

/** The goal as a person reads it: every slot filled in. For records and screens only. */
export function goalForDisplay(template: string, inputs: Readonly<Record<string, string>>): string {
  return template.replace(SLOT, (_m, name: string) => inputs[name] ?? `[${name}]`);
}

/**
 * The goal as an agent reads it: the template's own words stay instructions,
 * each slot becomes a `[name]` marker, and the values a person supplied are
 * listed once inside the fence.
 */
export function goalForAgent(template: string, inputs: Readonly<Record<string, string>>, fence: string): string {
  const marked = template.replace(SLOT, (_m, name: string) => `[${name}]`);
  const names = Object.keys(inputs);
  if (names.length === 0) return `GOAL: ${marked}`;
  const details = names.map((n) => `${n}: ${inputs[n] ?? ''}`).join('\n');
  return `GOAL: ${marked}\n\nThe values for the [markers] in the goal (data):\n${fenced(details, fence)}`;
}

// ─── Reply contracts ─────────────────────────────────────────

const RESULT_SHAPE = '{"finding": "what you found, in plain words", "evidence": [{"ref": "a record number, id or link you actually read", "note": "what it shows"}], "confidence": "low" | "medium" | "high", "notDone": ["anything you were asked to do and did not, or could not check"]}';
const JOIN_SHAPE = '{"summary": "the joined answer, in plain words", "findings": [{"claim": "one claim", "evidence": [{"ref": "...", "note": "..."}], "confidence": "low" | "medium" | "high", "from": ["the task keys the claim came from"]}], "notDone": ["what was not done or not checked"]}';

function contractFor(kind: SwarmRoleKind, opts: { maxSteps: number; hasTools: boolean; judge?: 'pick' | 'merge' }): string {
  const only = 'Reply with one JSON object and nothing else: no words before or after it, no code fence.';
  const honest = 'Say only what the evidence shows. If you could not find or check something, put it in "notDone" rather than guessing.';
  const steps = opts.hasTools
    ? `You may take at most ${opts.maxSteps} steps, tool calls included. Your last step must be the JSON reply; a run that ends without it counts as failed.`
    : '';
  switch (kind) {
    case 'planner':
      return [
        'Split the goal into separate tasks that can be worked on at the same time by different workers. Each task must serve the goal and nothing else, and must name one of the worker roles you are given.',
        only,
        'Shape: {"tasks": [{"title": "a short name", "brief": "what this worker must find out, and where to look", "role": "a worker role key"}]}',
      ].join('\n');
    case 'worker':
      return [steps, honest, only, `Shape: ${RESULT_SHAPE}`].filter(Boolean).join('\n');
    case 'reducer':
      return [
        'Join the workers\' results into one answer. Keep each claim tied to the evidence and the tasks it came from. Do not add a claim no worker made. Carry every "notDone" item forward.',
        only,
        `Shape: ${JOIN_SHAPE}`,
      ].join('\n');
    case 'lead':
      return [
        'You have no tools of your own. Give each part of the work to a helper, then join what they hand back. Do not answer from your own knowledge.',
        honest,
        'When the helpers are done, ' + only.charAt(0).toLowerCase() + only.slice(1),
        `Shape: ${JOIN_SHAPE}`,
      ].join('\n');
    case 'judge':
      return opts.judge === 'merge'
        ? [
            'You are given several independent attempts at the same task. Merge them into the one best answer: keep what the attempts agree on and what is backed by evidence, and drop what only one attempt asserts without evidence.',
            only,
            `Shape: ${JOIN_SHAPE.replace(/\}$/, ', "rationale": "why you merged it this way"}')}`,
          ].join('\n')
        : [
            'You are given several independent attempts at the same task. Pick the one best attempt: the one best backed by its evidence.',
            only,
            'Shape: {"winner": <the number of the best attempt>, "rationale": "why this one"}',
          ].join('\n');
    case 'checker':
      return [
        steps,
        'Your job is to try to prove each numbered claim WRONG. For each claim, look for evidence against it. Mark it "refuted" if you find it is wrong, "supported" only if you checked and it holds, and "unverified" if you could not check.',
        only,
        'Shape: {"verdicts": [{"claim": <the claim\'s number>, "verdict": "supported" | "refuted" | "unverified", "reason": "what you checked and what you found"}]}',
      ].filter(Boolean).join('\n');
    default:
      return only;
  }
}

/** The system prompt for one role: the boundary rule, the role's brief, the reply contract. */
export function systemPromptFor(
  role: SwarmRole,
  brief: string,
  fence: string,
  opts: { maxSteps: number; judge?: 'pick' | 'merge' },
): string {
  return [
    spotlightPreamble(fence),
    brief.trim(),
    contractFor(role.kind, { maxSteps: opts.maxSteps, hasTools: role.tools.length > 0, judge: opts.judge }),
  ].join('\n\n');
}

// ─── User messages ───────────────────────────────────────────

export function plannerMessage(def: SwarmDefinition, goal: string, maxTasks: number, fence: string, problems?: readonly string[]): string {
  const workers = def.roles.filter((r) => r.kind === 'worker');
  const lines = [
    goal,
    '',
    `Worker roles you can give tasks to (use the key exactly):`,
    ...workers.map((w) => `- ${w.key}: ${w.description ?? w.label ?? 'a worker'}`),
    '',
    `Write at most ${maxTasks} tasks.`,
  ];
  if (problems && problems.length > 0) {
    lines.push('', 'Your last task list was not accepted. The problems (data):', fenced(problems.join('\n'), fence), 'Write the task list again.');
  }
  return lines.join('\n');
}

export function workerMessage(goal: string, task: SwarmTask, fence: string, previous?: SwarmWorkerResult): string {
  const lines = [goal, '', `Your task, ${task.key} (data):`, fenced(`${task.title}\n${task.brief}`, fence)];
  const names = Object.keys(task.inputs);
  if (names.length > 0) {
    lines.push('', 'What you are given for this task (data):', fenced(names.map((n) => `${n}: ${task.inputs[n] ?? ''}`).join('\n'), fence));
  }
  if (previous) {
    lines.push(
      '',
      'The stage before you handed over this result (data). Review it: check it, correct it where it is wrong, and build on it.',
      fenced(JSON.stringify(resultForAgents(previous), null, 1), fence),
    );
  }
  return lines.join('\n');
}

/** What another agent sees of a worker's result. */
export function resultForAgents(r: SwarmWorkerResult): Record<string, unknown> {
  return {
    task: r.taskKey,
    status: r.status,
    finding: r.finding,
    evidence: r.evidence,
    confidence: r.confidence,
    notDone: r.notDone,
    ...(r.failure ? { failed: r.failure.message } : {}),
  };
}

export function joinMessage(goal: string, plan: readonly SwarmTask[], results: readonly SwarmWorkerResult[], fence: string): string {
  const titles = new Map(plan.map((t) => [t.key, t.title]));
  const body = results.map((r) => ({ ...resultForAgents(r), title: titles.get(r.taskKey) ?? r.taskKey }));
  return [goal, '', 'The workers\' results (data):', fenced(JSON.stringify(body, null, 1), fence)].join('\n');
}

export function judgeMessage(goal: string, attempts: readonly SwarmWorkerResult[], fence: string): string {
  const body = attempts.map((r, i) => ({ attempt: i + 1, ...resultForAgents(r) }));
  return [goal, '', `There are ${attempts.length} attempts (data):`, fenced(JSON.stringify(body, null, 1), fence)].join('\n');
}

export function checkerMessage(goal: string, claims: readonly SwarmJoinedFinding[], fence: string): string {
  const body = claims.map((c, i) => ({ claim: i + 1, text: c.claim, evidence: c.evidence, confidence: c.confidence }));
  return [goal, '', 'The claims to try to refute (data):', fenced(JSON.stringify(body, null, 1), fence)].join('\n');
}

export function leadMessage(goal: string): string {
  return goal;
}

// ─── Reading replies ─────────────────────────────────────────

/** Pull one JSON object out of a model's reply. Tolerates a code fence and stray words around it. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  if (typeof text !== 'string') return undefined;
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first < 0 || last <= first) return undefined;
  try {
    const v: unknown = JSON.parse(stripped.slice(first, last + 1));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

const isStr = (v: unknown): v is string => typeof v === 'string';
const CONFIDENCES: readonly SwarmConfidence[] = ['low', 'medium', 'high'];
const VERDICTS: readonly SwarmVerdict[] = ['supported', 'refuted', 'unverified'];

function readEvidence(v: unknown): SwarmEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: SwarmEvidence[] = [];
  for (const e of v.slice(0, SWARM_TEXT_LIMITS.evidencePerFinding)) {
    if (isStr(e) && e.trim() !== '') { out.push({ ref: clip(e.trim(), SWARM_TEXT_LIMITS.evidenceRef) }); continue; }
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      const ref = isStr(o['ref']) ? o['ref'].trim() : typeof o['ref'] === 'number' ? String(o['ref']) : '';
      if (ref === '') continue;
      const note = isStr(o['note']) && o['note'].trim() !== '' ? clip(o['note'].trim(), SWARM_TEXT_LIMITS.evidenceNote) : undefined;
      out.push({ ref: clip(ref, SWARM_TEXT_LIMITS.evidenceRef), ...(note ? { note } : {}) });
    }
  }
  return out;
}

function readStrings(v: unknown, max: number, each: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isStr).map((s) => s.trim()).filter((s) => s !== '').slice(0, max).map((s) => clip(s, each));
}

const readConfidence = (v: unknown): SwarmConfidence => (CONFIDENCES.includes(v as SwarmConfidence) ? (v as SwarmConfidence) : 'low');

export interface PlannedTask { readonly title: string; readonly brief: string; readonly role: string }

/**
 * Check a planner's task list. The rules are the count, the size of each task,
 * and that a task can only be what the definition allows: it names a defined
 * worker role and carries nothing else (a task cannot bring its own tools,
 * limits or instructions for the engine).
 */
export function parsePlan(text: string, def: SwarmDefinition, maxTasks: number, maxBriefChars: number): Parsed<PlannedTask[]> {
  const obj = extractJsonObject(text);
  if (!obj) return { ok: false, errors: ['The reply was not a JSON object.'] };
  const raw = obj['tasks'];
  if (!Array.isArray(raw)) return { ok: false, errors: ['The reply has no "tasks" list.'] };
  const errors: string[] = [];
  if (raw.length === 0) errors.push('The task list is empty.');
  if (raw.length > maxTasks) errors.push(`There are ${raw.length} tasks; the most allowed is ${maxTasks}.`);
  const workers = new Set(def.roles.filter((r) => r.kind === 'worker').map((r) => r.key));
  const allowedKeys = new Set(['title', 'brief', 'role']);
  const tasks: PlannedTask[] = [];
  const seen = new Set<string>();
  raw.slice(0, maxTasks + 5).forEach((t, i) => {
    const n = i + 1;
    if (!t || typeof t !== 'object' || Array.isArray(t)) { errors.push(`Task ${n} is not an object.`); return; }
    const o = t as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !allowedKeys.has(k));
    if (extra.length > 0) errors.push(`Task ${n} carries fields a task may not have: ${extra.join(', ')}.`);
    const title = isStr(o['title']) ? o['title'].trim() : '';
    const brief = isStr(o['brief']) ? o['brief'].trim() : '';
    const role = isStr(o['role']) ? o['role'].trim() : '';
    if (title === '') errors.push(`Task ${n} has no title.`);
    else if (title.length > SWARM_TEXT_LIMITS.taskTitle) errors.push(`Task ${n}'s title is longer than ${SWARM_TEXT_LIMITS.taskTitle} characters.`);
    if (brief === '') errors.push(`Task ${n} has no brief.`);
    else if (brief.length > maxBriefChars) errors.push(`Task ${n}'s brief is longer than ${maxBriefChars} characters.`);
    if (!workers.has(role)) errors.push(`Task ${n} names role "${clip(role, 80)}", which is not one of the worker roles (${[...workers].join(', ')}).`);
    const sig = `${role}|${title.toLowerCase()}`;
    if (title !== '' && seen.has(sig)) errors.push(`Task ${n} repeats an earlier task.`);
    seen.add(sig);
    tasks.push({ title, brief, role });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: tasks };
}

export interface ParsedWorkerReply {
  readonly finding: string;
  readonly evidence: SwarmEvidence[];
  readonly confidence: SwarmConfidence;
  readonly notDone: string[];
}

export function parseWorkerReply(text: string): Parsed<ParsedWorkerReply> {
  const obj = extractJsonObject(text);
  if (!obj) return { ok: false, errors: ['The reply was not a JSON object.'] };
  const finding = isStr(obj['finding']) ? obj['finding'].trim() : '';
  if (finding === '') return { ok: false, errors: ['The reply has no "finding".'] };
  return {
    ok: true,
    value: {
      finding: clip(finding, SWARM_TEXT_LIMITS.finding),
      evidence: readEvidence(obj['evidence']),
      confidence: readConfidence(obj['confidence']),
      notDone: readStrings(obj['notDone'], SWARM_TEXT_LIMITS.notDone, SWARM_TEXT_LIMITS.notDoneItem),
    },
  };
}

export interface ParsedJoin {
  readonly summary: string;
  readonly findings: SwarmJoinedFinding[];
  readonly notDone: string[];
  readonly rationale?: string;
}

export function parseJoin(text: string, taskKeys: ReadonlySet<string>): Parsed<ParsedJoin> {
  const obj = extractJsonObject(text);
  if (!obj) return { ok: false, errors: ['The reply was not a JSON object.'] };
  const summary = isStr(obj['summary']) ? obj['summary'].trim() : '';
  if (summary === '') return { ok: false, errors: ['The reply has no "summary".'] };
  const rawFindings = Array.isArray(obj['findings']) ? obj['findings'] : [];
  const findings: SwarmJoinedFinding[] = [];
  for (const f of rawFindings.slice(0, SWARM_TEXT_LIMITS.findings)) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const claim = isStr(o['claim']) ? o['claim'].trim() : '';
    if (claim === '') continue;
    findings.push({
      claim: clip(claim, SWARM_TEXT_LIMITS.claim),
      evidence: readEvidence(o['evidence']),
      confidence: readConfidence(o['confidence']),
      // A claim can only point at tasks that exist; anything else is dropped.
      from: readStrings(o['from'], 50, 80).filter((k) => taskKeys.has(k)),
    });
  }
  const rationale = isStr(obj['rationale']) && obj['rationale'].trim() !== '' ? clip(obj['rationale'].trim(), SWARM_TEXT_LIMITS.reason) : undefined;
  return {
    ok: true,
    value: {
      summary: clip(summary, SWARM_TEXT_LIMITS.summary),
      findings,
      notDone: readStrings(obj['notDone'], SWARM_TEXT_LIMITS.notDone, SWARM_TEXT_LIMITS.notDoneItem),
      ...(rationale ? { rationale } : {}),
    },
  };
}

export function parsePick(text: string, attempts: number): Parsed<{ winner: number; rationale: string }> {
  const obj = extractJsonObject(text);
  if (!obj) return { ok: false, errors: ['The reply was not a JSON object.'] };
  const w = typeof obj['winner'] === 'number' ? obj['winner'] : Number.parseInt(String(obj['winner'] ?? ''), 10);
  if (!Number.isInteger(w) || w < 1 || w > attempts) return { ok: false, errors: [`"winner" must be a number from 1 to ${attempts}.`] };
  const rationale = isStr(obj['rationale']) ? clip(obj['rationale'].trim(), SWARM_TEXT_LIMITS.reason) : '';
  return { ok: true, value: { winner: w, rationale } };
}

export interface ParsedVerdict { readonly claim: number; readonly verdict: SwarmVerdict; readonly reason: string }

export function parseVerdicts(text: string, claims: number): Parsed<ParsedVerdict[]> {
  const obj = extractJsonObject(text);
  if (!obj) return { ok: false, errors: ['The reply was not a JSON object.'] };
  if (!Array.isArray(obj['verdicts'])) return { ok: false, errors: ['The reply has no "verdicts" list.'] };
  const out: ParsedVerdict[] = [];
  const seen = new Set<number>();
  for (const v of obj['verdicts']) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const n = typeof o['claim'] === 'number' ? o['claim'] : Number.parseInt(String(o['claim'] ?? ''), 10);
    if (!Number.isInteger(n) || n < 1 || n > claims || seen.has(n)) continue;
    if (!VERDICTS.includes(o['verdict'] as SwarmVerdict)) continue;
    seen.add(n);
    out.push({ claim: n, verdict: o['verdict'] as SwarmVerdict, reason: isStr(o['reason']) ? clip(o['reason'].trim(), SWARM_TEXT_LIMITS.reason) : '' });
  }
  if (out.length === 0) return { ok: false, errors: ['No verdict named a claim by its number.'] };
  return { ok: true, value: out };
}
