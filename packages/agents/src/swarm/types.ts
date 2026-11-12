// SPDX-License-Identifier: MIT
/**
 * @weaveintel/agents — swarm: the contracts.
 *
 * A swarm is a group of agents set to one task under hard limits: plan, fan
 * out, join, check. This file holds the three kinds of contract:
 *
 *   1. the DEFINITION — plain, JSON-safe data that says how a swarm is shaped;
 *   2. the HOST PORTS — what an application supplies (models, tools, permission,
 *      approval, prompts, prices, a store);
 *   3. the RECORDS and RESULT — what a run leaves behind and hands back.
 *
 * Nothing here executes; `engine.ts` runs a definition.
 */

import type {
  AgentStep,
  ExecutionContext,
  Model,
  RunEventEnvelope,
  Tool,
} from '@weaveintel/core';
import type { CostLedger, PricingResolver } from '@weaveintel/cost-governor';
import type { CheckpointStore } from '../checkpoint.js';

// ─── 1. The definition (plain data) ──────────────────────────

/** The data-selected strategies the one engine can run. */
export const SWARM_PATTERNS = [
  'plan_fan_out_join',
  'map_reduce',
  'pipeline',
  'attempts_judge',
  'lead_helpers',
] as const;
export type SwarmPattern = (typeof SWARM_PATTERNS)[number];

export const SWARM_ROLE_KINDS = ['planner', 'worker', 'reducer', 'checker', 'judge', 'lead'] as const;
export type SwarmRoleKind = (typeof SWARM_ROLE_KINDS)[number];

/** One role in the swarm. Every role is run as one agent with a fresh context. */
export interface SwarmRole {
  /** Stable key, `^[a-zA-Z0-9_-]{1,64}$`. */
  readonly key: string;
  readonly kind: SwarmRoleKind;
  readonly label?: string;
  /** What this role is for; shown to a planner or a lead when they choose. */
  readonly description?: string;
  /** The role's brief, inline. */
  readonly prompt?: string;
  /** Or a key the host resolves to the brief (a prompt row, a skill). */
  readonly promptRef?: string;
  /** The host turns a purpose (for example `fast`, `balanced`, `deep`) into a model. */
  readonly modelPurpose: string;
  /** The smallest tool set, by name. Every name must match `^[a-zA-Z0-9_-]{1,128}$`. */
  readonly tools: readonly string[];
  /** Steps for this role; never above `limits.maxStepsPerAgent`. */
  readonly maxSteps?: number;
}

/** Hard limits. Every one is enforced in code, never by asking a model. */
export interface SwarmLimits {
  /** Most agent runs in the whole swarm (retries count). */
  readonly maxAgents: number;
  /** Most agents working at once. */
  readonly maxConcurrency: number;
  /** Most steps (model turns) one agent may take. */
  readonly maxStepsPerAgent: number;
  /** Wall-clock budget for the whole run, in milliseconds. */
  readonly maxWallClockMs: number;
  /** Most tokens (prompt + completion) across the run. */
  readonly maxTotalTokens?: number;
  /** Most money across the run, in US dollars. Needs a price for every model used. */
  readonly maxCostUsd?: number;
  /** Most model calls across the run. */
  readonly maxModelCalls?: number;
}

export interface SwarmFixedTask {
  readonly key: string;
  readonly title: string;
  /** What to look at, in a sentence. Reaches the worker as fenced data. */
  readonly focus?: string;
  readonly role: string;
}

/** Where the task list comes from. */
export type SwarmTaskSource =
  | { readonly kind: 'planner'; readonly role: string; readonly maxTasks?: number; readonly maxTaskChars?: number }
  | { readonly kind: 'fixed'; readonly tasks: readonly SwarmFixedTask[] }
  | { readonly kind: 'per_item'; readonly role: string; readonly maxItems?: number };

export const SWARM_JOIN_KINDS = ['reducer', 'judge_pick', 'judge_merge', 'last_stage', 'lead'] as const;
export type SwarmJoinKind = (typeof SWARM_JOIN_KINDS)[number];

export const SWARM_APPROVAL_POINTS = ['after_plan', 'before_write', 'before_finish'] as const;
export type SwarmApprovalPoint = (typeof SWARM_APPROVAL_POINTS)[number];

/** The whole swarm, as data. Safe to store as rows or JSON; holds no functions. */
export interface SwarmDefinition {
  readonly key: string;
  readonly label?: string;
  /** The goal, with `{{name}}` slots. Slot values reach agents as fenced data. */
  readonly goalTemplate: string;
  readonly pattern: SwarmPattern;
  readonly roles: readonly SwarmRole[];
  readonly limits: SwarmLimits;
  /** Not used by `pipeline` (its stages are the tasks) or `lead_helpers` (the lead decides). */
  readonly taskSource?: SwarmTaskSource;
  readonly join: { readonly kind: SwarmJoinKind; readonly role?: string };
  /** When set, a checker with a different brief tries to refute the important claims. */
  readonly checker?: { readonly role: string; readonly maxClaims?: number };
  readonly onFailure: {
    /** `continue`: one failed worker does not sink the run. `fail_run`: it does. */
    readonly worker: 'continue' | 'fail_run';
    /** Bounded retry per task (0 = no retry). */
    readonly maxRetriesPerTask: number;
    /** The run fails if fewer workers than this succeed (default 1). */
    readonly minWorkersOk?: number;
  };
  readonly approvalPoints: readonly SwarmApprovalPoint[];
  /** Write tools the swarm may use. A write tool not named here is refused. */
  readonly writeTools?: readonly string[];
  /** `pipeline`: worker role keys in order; each stage reviews the one before. */
  readonly stages?: readonly string[];
  /** `attempts_judge`: how many independent attempts (default 3). */
  readonly attempts?: number;
}

// ─── 2. Host ports ───────────────────────────────────────────

/** The person the whole run acts as. Frozen at start; no agent can change it. */
export interface SwarmPrincipal {
  readonly userId: string;
  readonly tenantId?: string;
  readonly roles?: readonly string[];
  /** Opaque to the engine; handed back to the host's ports untouched. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface SwarmToolCall {
  readonly principal: SwarmPrincipal;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly taskKey: string;
  readonly role: string;
}

export interface SwarmApprovalRequest {
  readonly point: SwarmApprovalPoint;
  readonly runId: string;
  readonly principal: SwarmPrincipal;
  /** A sentence for the person deciding. */
  readonly summary: string;
  /** Set for `before_write`. */
  readonly toolCall?: SwarmToolCall;
  /** Set for `after_plan`. */
  readonly tasks?: readonly SwarmTask[];
}

/** `pending` parks the run (`waiting_approval`); the host resumes it once somebody decides. */
export type SwarmApprovalAnswer = 'approved' | 'denied' | 'pending';

/** What an application supplies. The engine holds no model, tool or policy of its own. */
export interface SwarmHost {
  /** Model by purpose. Called once per role per run. */
  modelFor(purpose: string, role: SwarmRole): Model | Promise<Model>;
  readonly tools: {
    /** The tool for this name, acting for this person. `undefined` = no such tool. */
    get(name: string, principal: SwarmPrincipal): Tool | undefined;
    /** Whether a tool writes. Without it the tool's own `riskLevel` and `tags` decide. */
    isWrite?(name: string): boolean;
  };
  /** Asked before EVERY tool call, as the starting person. */
  readonly permission: {
    check(call: SwarmToolCall): Promise<{ allow: boolean; reason?: string }>;
  };
  /** Needed when the definition has approval points or write tools. */
  readonly approval?: {
    request(req: SwarmApprovalRequest): Promise<SwarmApprovalAnswer>;
  };
  /** Needed when a role uses `promptRef`. */
  readonly prompt?: {
    resolve(ref: string, role: SwarmRole): Promise<string> | string;
  };
  /** Needed when `limits.maxCostUsd` is set: a call whose model has no price is refused. */
  readonly pricing?: PricingResolver;
  /** Where each model call's cost is recorded (in-memory by default). */
  readonly ledger?: CostLedger;
  /** When given, each worker's agent loop checkpoints here. */
  readonly workerCheckpoints?: CheckpointStore;
}

// ─── 3. Records and result ───────────────────────────────────

export type SwarmRunStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** Why a run stopped before it finished everything. */
export type SwarmStopReason =
  | 'limit_agents'
  | 'limit_cost'
  | 'limit_tokens'
  | 'limit_time'
  | 'limit_model_calls'
  | 'cost_unknown'
  | 'cancelled'
  | 'approval_denied'
  | 'approval_pending'
  | 'planner_invalid'
  | 'worker_failed'
  | 'too_few_workers'
  | 'lead_did_not_delegate'
  | 'join_failed'
  | 'check_failed'
  | 'interrupted'
  | 'engine_error';

export type SwarmTaskStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

/** One unit of work for one worker. */
export interface SwarmTask {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly role: string;
  readonly position: number;
  /** Task keys that must finish first (pipeline stages). */
  readonly dependsOn: readonly string[];
  /** The inputs this task needs, and no others. Reach the worker as fenced data. */
  readonly inputs: Readonly<Record<string, string>>;
  status: SwarmTaskStatus;
  /** Agent runs spent on this task so far. */
  attempts: number;
}

export type SwarmConfidence = 'low' | 'medium' | 'high';

export interface SwarmEvidence {
  /** A pointer the host understands: a record number, a link, an id. */
  readonly ref: string;
  readonly note?: string;
}

export type SwarmFailureReason =
  | 'error'
  | 'malformed_result'
  | 'limit_steps'
  | 'limit'
  | 'cancelled'
  | 'upstream_failed'
  | 'agent_failed';

export interface SwarmFailure {
  readonly taskKey: string;
  readonly role: string;
  readonly attempt: number;
  readonly reason: SwarmFailureReason | SwarmStopReason;
  readonly message: string;
  /** Whether the engine ran the task again after this failure. */
  readonly retried: boolean;
}

/** A condensed step of one agent's trace. A delegation shows as a `tool_call`. */
export interface SwarmTraceStep {
  readonly type: AgentStep['type'];
  readonly tool?: string;
  readonly durationMs: number;
}

export interface SwarmAgentUsage {
  readonly steps: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
}

/** What one agent handed back. Always this shape, whatever the model wrote. */
export interface SwarmWorkerResult {
  readonly taskKey: string;
  readonly role: string;
  readonly kind: SwarmRoleKind;
  readonly status: 'ok' | 'failed';
  /** False when the reply was not in the agreed structure and was kept as plain text. */
  readonly structured: boolean;
  readonly finding: string;
  readonly evidence: readonly SwarmEvidence[];
  readonly confidence: SwarmConfidence;
  readonly notDone: readonly string[];
  readonly attempt: number;
  readonly failure?: { readonly reason: SwarmFailure['reason']; readonly message: string };
  readonly usage: SwarmAgentUsage;
  readonly trace: readonly SwarmTraceStep[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

export type SwarmVerdict = 'supported' | 'refuted' | 'unverified';

export interface SwarmJoinedFinding {
  readonly claim: string;
  readonly evidence: readonly SwarmEvidence[];
  readonly confidence: SwarmConfidence;
  /** Task keys this claim came from. */
  readonly from: readonly string[];
  /** Set by the checker. */
  verdict?: SwarmVerdict;
  verdictReason?: string;
}

export interface SwarmJoined {
  readonly summary: string;
  readonly findings: SwarmJoinedFinding[];
  readonly notDone: string[];
  /** True when the join was done in code because the run could not pay for a reducer, or a part is missing. */
  readonly partial: boolean;
  readonly by: 'reducer' | 'judge' | 'last_stage' | 'lead' | 'code';
  readonly winner?: string;
  readonly rationale?: string;
}

export interface SwarmCheck {
  readonly outcome: 'supported' | 'refuted' | 'unverified';
  readonly verdicts: readonly { readonly claim: number; readonly verdict: SwarmVerdict; readonly reason: string }[];
}

export interface SwarmUsage {
  agentsStarted: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  /** The most agents that were working at the same moment. */
  peakConcurrency: number;
  wallClockMs: number;
}

export interface SwarmRunResult {
  readonly runId: string;
  readonly definitionKey: string;
  readonly status: SwarmRunStatus;
  readonly stopReason?: SwarmStopReason;
  /** A sentence that says what stopped the run, when something did. */
  readonly stopDetail?: string;
  readonly goal: string;
  readonly plan: readonly SwarmTask[];
  /** One result per task: what each worker handed back. */
  readonly results: readonly SwarmWorkerResult[];
  /** The agents that ran around the workers: planner, reducer, judge, checker, lead. */
  readonly coordination: readonly SwarmWorkerResult[];
  readonly joined?: SwarmJoined;
  readonly check?: SwarmCheck;
  readonly failures: readonly SwarmFailure[];
  readonly usage: SwarmUsage;
}

/** The run as the store keeps it. */
export interface SwarmRunRecord {
  readonly runId: string;
  readonly definitionKey: string;
  readonly pattern: SwarmPattern;
  readonly goal: string;
  readonly principal: SwarmPrincipal;
  readonly inputs: Readonly<Record<string, string>>;
  readonly items: readonly SwarmItem[];
  status: SwarmRunStatus;
  stopReason?: SwarmStopReason;
  stopDetail?: string;
  /** Which approval point the run is parked at, when it is waiting. */
  waitingAt?: SwarmApprovalPoint;
  /** Approval points already passed, so a resume does not ask twice. */
  approved: SwarmApprovalPoint[];
  usage: SwarmUsage;
  joined?: SwarmJoined;
  check?: SwarmCheck;
  failures: SwarmFailure[];
  readonly startedAt: number;
  finishedAt?: number;
}

export interface SwarmCostEntry {
  readonly runId: string;
  readonly taskKey: string;
  readonly role: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  /** False when no price was known for the model. */
  readonly priced: boolean;
  readonly at: number;
}

export interface SwarmRunSnapshot {
  readonly run: SwarmRunRecord;
  readonly tasks: readonly SwarmTask[];
  readonly results: readonly SwarmWorkerResult[];
  readonly lastSequence: number;
}

/**
 * Where a run's state goes. The default keeps it in memory; a host implements
 * this on its own tables to make runs survive a restart.
 */
export interface SwarmRunStore {
  createRun(run: SwarmRunRecord): Promise<void>;
  updateRun(runId: string, run: SwarmRunRecord): Promise<void>;
  putTask(runId: string, task: SwarmTask): Promise<void>;
  putResult(runId: string, result: SwarmWorkerResult): Promise<void>;
  appendEvent(event: RunEventEnvelope): Promise<void>;
  recordCost(entry: SwarmCostEntry): Promise<void>;
  load(runId: string): Promise<SwarmRunSnapshot | undefined>;
}

/** One input item for a `per_item` (map) swarm. */
export interface SwarmItem {
  readonly key: string;
  readonly title: string;
  readonly detail?: string;
}

export interface SwarmStartInput {
  /** Values for the goal template's `{{name}}` slots. */
  readonly inputs?: Readonly<Record<string, string>>;
  /** The list a `per_item` swarm maps over. */
  readonly items?: readonly SwarmItem[];
  readonly principal: SwarmPrincipal;
  readonly runId?: string;
  /** Parent context (tracing, runtime). The engine sets its own signal and deadline. */
  readonly ctx?: ExecutionContext;
  readonly onEvent?: (event: RunEventEnvelope) => void;
}

export interface SwarmRunHandle {
  readonly runId: string;
  /** Settles when the run stops for any reason. Never rejects: a failure is a result. */
  readonly result: Promise<SwarmRunResult>;
  /** Stops new work at once; an agent in flight stops at its next step. */
  cancel(reason?: string): void;
  subscribe(listener: (event: RunEventEnvelope) => void): () => void;
}

/** What a person is shown before a swarm starts. Worked out in code; no model is called. */
export interface SwarmEstimate {
  readonly pattern: SwarmPattern;
  readonly agentsMin: number;
  readonly agentsMax: number;
  readonly maxConcurrency: number;
  readonly modelCallsMax: number;
  readonly costCapUsd?: number;
  readonly wallClockCapMs: number;
  readonly readsOnly: boolean;
  readonly writeTools: readonly string[];
  readonly approvalPoints: readonly SwarmApprovalPoint[];
  /** The roles that will work, in plain words. */
  readonly roles: readonly { readonly key: string; readonly kind: SwarmRoleKind; readonly label: string; readonly tools: readonly string[] }[];
}

/** The `payload.type` values the engine puts on `step.update` events. */
export const SWARM_STEP_TYPES = [
  'swarm.planned',
  'swarm.worker.started',
  'swarm.worker.finished',
  'swarm.joined',
  'swarm.checked',
] as const;
export type SwarmStepType = (typeof SWARM_STEP_TYPES)[number];

/** Task keys the engine keeps for the agents that are not workers. A task may not start with `swarm_`. */
export const SWARM_COORDINATION_KEYS = {
  planner: 'swarm_plan',
  reducer: 'swarm_join',
  judge: 'swarm_join',
  checker: 'swarm_check',
  lead: 'swarm_lead',
} as const;

/** The tool-name rule every model provider accepts. */
export const SWARM_TOOL_NAME_RULE = /^[a-zA-Z0-9_-]{1,128}$/;
export const SWARM_KEY_RULE = /^[a-zA-Z0-9_-]{1,64}$/;
