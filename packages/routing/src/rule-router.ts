// SPDX-License-Identifier: MIT
/**
 * @weaveintel/routing — Rule router
 *
 * What this is, in plain words
 * ----------------------------
 * A host application keeps a list of models it may use ("targets") and a list
 * of routes ("rules"). A rule says: "for this kind of work (chat, agent, judge,
 * summarise, embed ...) try these models in this order". This file turns those
 * rows into a decision:
 *
 *   1. `plan(request)`  — which model would be used, which were skipped, and a
 *      sentence an administrator can read that says why. It calls nothing.
 *   2. `run(request, attempt)` — makes the same decision, then calls the
 *      caller's `attempt` function for the chosen model. If that model fails,
 *      the next one in the list is tried ("fail-over").
 *
 * Everything is plain data. The router knows nothing about any provider SDK
 * and makes no network calls itself; the caller supplies the function that
 * actually talks to a model. `targets`, `rules` and `dataRule` may be passed
 * as functions so the host can say "read the current rows" — a row changed by
 * an administrator takes effect on the very next request, with no restart.
 *
 * Three safety behaviours worth knowing about
 * -------------------------------------------
 * - Pausing a failing model. Each target has a circuit breaker (from
 *   `@weaveintel/resilience`). After several failures in a row the target is
 *   skipped for a cool-down period instead of being hammered, then tried again.
 *   The breaker keeps time with the system clock.
 * - Staying with one model during a run ("stickiness"). When a request carries
 *   an `affinityKey` (one run / one thread) and a model has already answered
 *   for that key, later requests start with the same model so the answers do
 *   not change voice half-way through.
 * - Never mixing embedding models. Vectors produced by two different embedding
 *   models cannot be compared with each other. So an embedding route may only
 *   fall back to the SAME model and size hosted by another provider. A step
 *   that would produce different vectors is always skipped, and when nothing
 *   compatible is left the request fails with a clear message rather than
 *   quietly producing vectors that would corrupt a search index.
 */

import { WeaveIntelError, profileFeatures, profileSupports, requiredFeatures } from '@weaveintel/core';
import type { ModelCapabilityProfile, ModelRequest } from '@weaveintel/core';
import { createCircuitBreaker, PROVIDER_RESILIENCE_DEFAULTS } from '@weaveintel/resilience';
import type { CircuitBreaker, CircuitState } from '@weaveintel/resilience';

// ─── Data the host stores (plain, serialisable rows) ─────────

/** What the request is for. The well-known values get friendlier wording; any other string works too. */
export type RoutePurpose = 'chat' | 'agent' | 'judge' | 'summarise' | 'embed' | (string & {});

/** One provider + model pair the host is able to call. */
export interface RouteTarget {
  /** Unique id of this provider+model pair. Rule steps point at it. */
  readonly key: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Friendly name for explanations. Falls back to "providerId modelId". */
  readonly displayName?: string;
  readonly kind: 'chat' | 'embedding';
  readonly enabled: boolean;
  /** Whether the provider as a whole is switched on. Default true. */
  readonly providerEnabled?: boolean;
  /** What the model can do, e.g. 'tools', 'vision', 'pdf', 'audio_in', 'structured_output', 'document:text/csv'. */
  readonly capabilities?: readonly string[];
  /**
   * The model's capability profile (declared or measured by the conformance
   * probe). When present, its features count as well as `capabilities`, and
   * its context size is used when `contextTokens` is not set.
   */
  readonly profile?: ModelCapabilityProfile;
  readonly contextTokens?: number;
  readonly region?: string;
  /** USD per million input tokens. */
  readonly inputPricePerMTok?: number;
  /** USD per million output tokens. */
  readonly outputPricePerMTok?: number;
  readonly typicalLatencyMs?: number;
  /** Embedding targets only: models that produce interchangeable vectors share this string (e.g. "text-embedding-3-large@512"). */
  readonly vectorSpace?: string;
}

/** One entry in a rule's ordered list of models to try. */
export interface RouteStep {
  readonly targetKey: string;
  /** Lower numbers are tried first. */
  readonly order: number;
  /** Default true. A switched-off step is ignored entirely. */
  readonly enabled?: boolean;
}

/** What a request (or a rule) requires of a model. */
export interface RouteNeeds {
  readonly capabilities?: readonly string[];
  readonly minContextTokens?: number;
}

/** "For this purpose, try these models in this order, within these limits." */
export interface RouteRule {
  readonly key: string;
  readonly purpose: RoutePurpose;
  /** Default true. */
  readonly enabled?: boolean;
  readonly needs?: RouteNeeds;
  /** Ceiling on the blended price: (input price + output price) / 2, USD per million tokens. */
  readonly maxCostPerMTok?: number;
  readonly maxLatencyMs?: number;
  /** Stay with the model that already answered for the same affinity key. Default true. */
  readonly sticky?: boolean;
  /** Tried in ascending `order`. */
  readonly steps: readonly RouteStep[];
}

/**
 * Where data is allowed to go. A field left undefined means "no restriction";
 * an empty array means "nothing is allowed".
 */
export interface DataRule {
  readonly allowedProviders?: readonly string[];
  readonly allowedRegions?: readonly string[];
}

/** One thing the caller wants routed. */
export interface RouteRequest {
  readonly purpose: RoutePurpose;
  readonly tenantId?: string;
  /** Added to the rule's own needs: capabilities are combined, the larger context size wins. */
  readonly needs?: RouteNeeds;
  /** Identifies one run / one thread. Setting it enables stickiness. */
  readonly affinityKey?: string;
}

// ─── What the router reports back ────────────────────────────

/** Why a step was not usable. */
export type DropReason =
  | 'unknown_target'
  | 'switched_off'
  | 'wrong_kind'
  | 'different_vector_space'
  | 'provider_not_allowed'
  | 'region_not_allowed'
  | 'missing_capability'
  | 'context_too_small'
  | 'over_cost_ceiling'
  | 'too_slow'
  | 'circuit_open';

/** One step of the rule, with the verdict on it. */
export interface RouteCandidate {
  readonly targetKey: string;
  /** Empty when the target is unknown. */
  readonly providerId: string;
  /** Empty when the target is unknown. */
  readonly modelId: string;
  readonly order: number;
  readonly eligible: boolean;
  readonly dropped?: DropReason;
  /** Short plain-language note on the verdict. */
  readonly detail: string;
}

/** The decision for one request. Plain data: safe to log or store. */
export interface RoutePlan {
  readonly purpose: RoutePurpose;
  /** Undefined when no rule covers the purpose. */
  readonly ruleKey?: string;
  /** Every enabled step of the rule, usable or not, with reasons. */
  readonly candidates: readonly RouteCandidate[];
  /** Usable target keys in the order they will be tried. */
  readonly order: readonly string[];
  /** The first of `order`. */
  readonly chosen?: string;
  /** True when the first choice was moved to the front because it answered earlier for the same affinity key. */
  readonly sticky: boolean;
  /** Embedding routes only: the vector space every usable step shares. */
  readonly vectorSpace?: string;
  /** Plain English, readable by a non-technical administrator. */
  readonly explanation: string;
}

/** What happened with one target during `run`. */
export interface RouteAttempt {
  readonly targetKey: string;
  readonly ok: boolean;
  /** Set when the target was not called at all because it had just been paused. */
  readonly skipped?: 'circuit_open';
  readonly errorCode?: string;
  /** Copied as given by the caller's attempt function (the caller has already scrubbed it). */
  readonly errorMessage?: string;
  readonly durationMs: number;
}

/** The result of a successful `run`. */
export interface RouteOutcome<T> {
  readonly value: T;
  /** The target that produced the value. */
  readonly target: RouteTarget;
  readonly plan: RoutePlan;
  readonly attempts: readonly RouteAttempt[];
  /** The plan's explanation, extended with what actually happened. */
  readonly explanation: string;
}

/** Extra facts handed to the caller's attempt function. */
export interface RouteAttemptInfo {
  /** 1 for the first model actually called, 2 for the next, and so on. */
  readonly attemptNumber: number;
  readonly plan: RoutePlan;
}

export interface RouteRunOptions {
  /**
   * Decide whether a failure should move on to the next model. Return false to
   * stop and hand the error straight back. Default: move on for everything
   * except errors that are the request's own fault (see `run`).
   */
  readonly shouldFailOver?: (error: unknown) => boolean;
}

/** Health of one target as the router currently sees it. */
export interface RouteTargetHealth {
  readonly targetKey: string;
  readonly state: CircuitState;
  readonly consecutiveFailures?: number;
}

export interface RuleRouterOptions {
  /** The models that may be used: the rows, or a function that returns the current rows. */
  readonly targets: readonly RouteTarget[] | (() => readonly RouteTarget[]);
  /** The routes: the rows, or a function that returns the current rows. */
  readonly rules: readonly RouteRule[] | (() => readonly RouteRule[]);
  /** Where data may go: one rule for everyone, or a function so it can differ per tenant. */
  readonly dataRule?: DataRule | ((request: RouteRequest) => DataRule | undefined);
  /** When to pause a failing target and for how long. Defaults to the shared provider defaults. */
  readonly breaker?: { readonly failureThreshold?: number; readonly cooldownMs?: number };
  /** Live measurements, if the host has them. A measured latency replaces the target's typical one. */
  readonly health?: (targetKey: string) => { readonly latencyMs?: number } | undefined;
  /** Clock used to time attempts. Default `Date.now`. (The breakers always use the system clock.) */
  readonly now?: () => number;
  /** How many affinity keys to remember. Default 5000; the oldest is forgotten first. */
  readonly maxAffinityEntries?: number;
}

export interface RuleRouter {
  /** Decide, without calling anything. */
  plan(request: RouteRequest): RoutePlan;
  /** Decide, then call `attempt` for each usable target in turn until one succeeds. */
  run<T>(
    request: RouteRequest,
    attempt: (target: RouteTarget, info: RouteAttemptInfo) => Promise<T>,
    opts?: RouteRunOptions,
  ): Promise<RouteOutcome<T>>;
  /** Current breaker state per target. */
  health(): readonly RouteTargetHealth[];
  /** Forget all breaker state and all remembered affinity. */
  reset(): void;
}

// ─── Wording helpers ─────────────────────────────────────────

/**
 * Errors that are the request's own fault, not the model's. Trying another
 * model would not help, and they say nothing about the model's health.
 */
const CALLER_FAULT_CODES: ReadonlySet<string> = new Set([
  'INVALID_INPUT',
  'CANCELLED',
  'POLICY_DENIED',
  'BUDGET_EXCEEDED',
]);

const PURPOSE_LABELS: ReadonlyMap<string, string> = new Map([
  ['chat', 'chat'],
  ['agent', 'agent work'],
  ['judge', 'judging'],
  ['summarise', 'summarising'],
  ['embed', 'embeddings'],
]);

const FAILURE_PHRASES: ReadonlyMap<string, string> = new Map([
  ['RATE_LIMITED', 'rate limited'],
  ['TIMEOUT', 'timed out'],
  ['AUTH_FAILED', 'the provider rejected the credentials'],
  ['PERMISSION_DENIED', 'permission denied'],
  ['NOT_FOUND', 'model not found'],
  ['MODEL_ERROR', 'model error'],
  ['PROVIDER_ERROR', 'provider error'],
  ['CIRCUIT_OPEN', 'paused after repeated failures'],
  ['INVALID_INPUT', 'the request was rejected as invalid'],
  ['CANCELLED', 'cancelled'],
  ['POLICY_DENIED', 'blocked by policy'],
  ['BUDGET_EXCEEDED', 'over budget'],
]);

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'] as const;

const PAUSED = 'paused after repeated failures';

const NOT_SENT_ELSEWHERE =
  'The request was not sent to a different embedding model, because vectors from different models cannot be compared.';

function purposeLabel(purpose: RoutePurpose): string {
  return PURPOSE_LABELS.get(purpose) ?? purpose;
}

function choiceLabel(position: number): string {
  const word = ORDINALS[position - 1];
  return word === undefined ? `choice number ${position}` : `${word} choice`;
}

function targetName(target: RouteTarget): string {
  return target.displayName ?? `${target.providerId} ${target.modelId}`;
}

/** "A", "A and B", "A, B and C". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** Joins whole clauses: "A is off, and B is too slow". */
function joinClauses(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1] ?? ''}`;
}

/** Reads `error.code` without depending on any particular error class. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failurePhrase(code: string | undefined): string {
  return (code === undefined ? undefined : FAILURE_PHRASES.get(code)) ?? 'error';
}

function defaultShouldFailOver(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === undefined || !CALLER_FAULT_CODES.has(code);
}

// ─── Judging one step ────────────────────────────────────────

/** Why a step is unusable, in three wordings: a note, a bracketed aside, and a full clause. */
interface Verdict {
  readonly dropped: DropReason;
  readonly detail: string;
  /** Fits inside brackets after the name: "Skipped X (…)". */
  readonly aside: string;
  /** Follows the name to make a clause: "X …". */
  readonly clause: string;
}

/** A candidate plus the wording needed to explain it. */
interface Judged {
  readonly candidate: RouteCandidate;
  readonly name: string;
  readonly verdict?: Verdict;
}

interface JudgeContext {
  readonly purpose: RoutePurpose;
  readonly rule: RouteRule;
  readonly dataRule: DataRule | undefined;
  readonly capabilities: readonly string[];
  readonly minContextTokens: number | undefined;
  /** For embedding routes: the vector space this step would have to match, and its own. */
  readonly spaces: { readonly own: string; readonly route: string } | undefined;
  readonly latencyMs: number | undefined;
  readonly circuitState: CircuitState;
}

function capabilityName(capability: string): string {
  if (capability === 'pdf') return 'PDF files';
  if (capability === 'audio_in') return 'audio input';
  if (capability.startsWith('document:')) return `${capability.slice('document:'.length)} files`;
  return capability;
}

/**
 * Whether a target has one capability: listed in `capabilities` (a
 * `document:text/*` entry matches every text type), or present in its profile.
 */
function targetSupports(target: RouteTarget, capability: string): boolean {
  const listed = target.capabilities ?? [];
  if (listed.includes(capability)) return true;
  if (capability.startsWith('document:')) {
    const mime = capability.slice('document:'.length);
    if (listed.some((c) => c.startsWith('document:') && c.endsWith('/*') && mime.startsWith(c.slice('document:'.length, -1)))) return true;
  }
  return target.profile !== undefined && profileSupports(target.profile, capability);
}

/**
 * What a model request needs of a model, as route needs: one capability per
 * kind of content it carries (`vision`, `pdf`, `audio_in`, `document:<mime>`),
 * plus `structured_output` and `tools` when asked for. Pass it as
 * `RouteRequest.needs` so a model that cannot read the content is skipped
 * BEFORE any call is made.
 */
export function needsForRequest(
  request: Pick<ModelRequest, 'messages'> & Partial<Pick<ModelRequest, 'tools' | 'responseFormat'>>,
  extra?: RouteNeeds,
): RouteNeeds {
  const capabilities = [...new Set([...requiredFeatures(request), ...(extra?.capabilities ?? [])])];
  return {
    capabilities,
    ...(extra?.minContextTokens !== undefined ? { minContextTokens: extra.minContextTokens } : {}),
  };
}

/** The flat capability list for a target built from a profile. */
export function capabilitiesOfProfile(profile: ModelCapabilityProfile): string[] {
  return profileFeatures(profile);
}

/** Returns the first reason the target cannot be used, or undefined when it can. */
function judgeTarget(target: RouteTarget, ctx: JudgeContext): Verdict | undefined {
  if (!target.enabled || target.providerEnabled === false) {
    const what = target.enabled ? 'its provider is switched off' : 'the model is switched off';
    return { dropped: 'switched_off', detail: what, aside: 'switched off', clause: 'is switched off' };
  }

  const wantKind = ctx.purpose === 'embed' ? 'embedding' : 'chat';
  if (target.kind !== wantKind) {
    return wantKind === 'embedding'
      ? {
          dropped: 'wrong_kind',
          detail: 'this route needs an embedding model and this is a chat model',
          aside: 'not an embedding model',
          clause: 'is not an embedding model',
        }
      : {
          dropped: 'wrong_kind',
          detail: 'this route needs a chat model and this is an embedding model',
          aside: 'an embedding model, not a chat model',
          clause: 'is an embedding model, not a chat model',
        };
  }

  if (ctx.spaces !== undefined && ctx.spaces.own !== ctx.spaces.route) {
    return {
      dropped: 'different_vector_space',
      detail: `vectors from ${ctx.spaces.own} cannot be compared with vectors from ${ctx.spaces.route}`,
      aside: "its vectors cannot be mixed with the first choice's",
      clause: "was skipped because its vectors cannot be mixed with the first choice's",
    };
  }

  const allowedProviders = ctx.dataRule?.allowedProviders;
  if (allowedProviders !== undefined && !allowedProviders.includes(target.providerId)) {
    return {
      dropped: 'provider_not_allowed',
      detail: `provider ${target.providerId} is not on the allowed list`,
      aside: 'provider not allowed for this workspace',
      clause: 'comes from a provider that is not allowed for this workspace',
    };
  }

  const allowedRegions = ctx.dataRule?.allowedRegions;
  if (allowedRegions !== undefined && (target.region === undefined || !allowedRegions.includes(target.region))) {
    return {
      dropped: 'region_not_allowed',
      detail:
        target.region === undefined
          ? 'no region is recorded for this model and only some regions are allowed'
          : `region ${target.region} is not on the allowed list`,
      aside: 'region not allowed for this workspace',
      clause: 'is hosted in a region that is not allowed for this workspace',
    };
  }

  const missing = ctx.capabilities.filter((capability) => !targetSupports(target, capability));
  if (missing.length > 0) {
    // The newer input features get readable names ("PDF files", "text/csv files");
    // the older ones keep their own names, so existing wording is unchanged.
    const phrase = `does not support ${joinList(missing.map(capabilityName))}`;
    return {
      dropped: 'missing_capability',
      detail: `missing capability: ${missing.join(', ')}`,
      aside: phrase,
      clause: phrase,
    };
  }

  // A stated minimum is a hard requirement, so a model with no recorded size cannot be assumed to fit.
  const contextTokens = target.contextTokens ?? target.profile?.contextTokens;
  if (ctx.minContextTokens !== undefined && (contextTokens ?? 0) < ctx.minContextTokens) {
    return {
      dropped: 'context_too_small',
      detail:
        contextTokens === undefined
          ? `needs room for ${ctx.minContextTokens} tokens and no context size is recorded for this model`
          : `needs room for ${ctx.minContextTokens} tokens and this model holds ${contextTokens}`,
      aside: 'context window too small',
      clause: 'cannot hold a request this large',
    };
  }

  // A target with no prices at all is left alone: an unknown price is not a known breach.
  const hasPrice = target.inputPricePerMTok !== undefined || target.outputPricePerMTok !== undefined;
  if (ctx.rule.maxCostPerMTok !== undefined && hasPrice) {
    const blended = ((target.inputPricePerMTok ?? 0) + (target.outputPricePerMTok ?? 0)) / 2;
    if (blended > ctx.rule.maxCostPerMTok) {
      return {
        dropped: 'over_cost_ceiling',
        detail: `blended price ${blended} per million tokens is above the limit of ${ctx.rule.maxCostPerMTok}`,
        aside: 'over the cost limit for this route',
        clause: 'costs more than this route allows',
      };
    }
  }

  // Likewise an unknown latency is not treated as slow.
  if (ctx.rule.maxLatencyMs !== undefined && ctx.latencyMs !== undefined && ctx.latencyMs > ctx.rule.maxLatencyMs) {
    return {
      dropped: 'too_slow',
      detail: `responds in about ${ctx.latencyMs} ms and the limit is ${ctx.rule.maxLatencyMs} ms`,
      aside: 'too slow for this route',
      clause: 'is slower than this route allows',
    };
  }

  if (ctx.circuitState === 'open') {
    return {
      dropped: 'circuit_open',
      detail: 'paused after repeated failures; it will be tried again after a short wait',
      aside: PAUSED,
      clause: `is ${PAUSED}`,
    };
  }

  return undefined;
}

// ─── The router ──────────────────────────────────────────────

/** Everything `run` needs from a decision, beyond the public plan. */
interface Decision {
  readonly plan: RoutePlan;
  readonly judged: readonly Judged[];
  readonly targets: ReadonlyMap<string, RouteTarget>;
  /** Where to remember which target answered; undefined when stickiness does not apply. */
  readonly affinityId: string | undefined;
}

function skippedSentence(judged: readonly Judged[]): string {
  const skipped = judged.flatMap((entry) => (entry.verdict ? [`${entry.name} (${entry.verdict.aside})`] : []));
  return skipped.length > 0 ? ` Skipped ${joinList(skipped)}.` : '';
}

/**
 * Build a rule router over plain data.
 *
 * @example
 * const router = createRuleRouter({ targets: () => readTargetRows(), rules: () => readRuleRows() });
 * const outcome = await router.run({ purpose: 'chat', affinityKey: runId }, (target) => callModel(target));
 */
export function createRuleRouter(options: RuleRouterOptions): RuleRouter {
  // Looked up on each call (not captured once) so a test that swaps the system clock is respected.
  const now = options.now ?? ((): number => Date.now());
  const maxAffinityEntries = options.maxAffinityEntries ?? 5000;
  const breakerOptions = {
    failureThreshold: options.breaker?.failureThreshold ?? PROVIDER_RESILIENCE_DEFAULTS.circuit.failureThreshold,
    cooldownMs: options.breaker?.cooldownMs ?? PROVIDER_RESILIENCE_DEFAULTS.circuit.cooldownMs,
  };

  /** One breaker per target key, made the first time the target is attempted. */
  const breakers = new Map<string, CircuitBreaker>();
  /** affinity id → key of the target that last answered. Insertion order doubles as age. */
  const affinity = new Map<string, string>();

  function breakerFor(targetKey: string): CircuitBreaker {
    let breaker = breakers.get(targetKey);
    if (breaker === undefined) {
      breaker = createCircuitBreaker(breakerOptions);
      breakers.set(targetKey, breaker);
    }
    return breaker;
  }

  function readTargets(): readonly RouteTarget[] {
    return typeof options.targets === 'function' ? options.targets() : options.targets;
  }

  function readRules(): readonly RouteRule[] {
    return typeof options.rules === 'function' ? options.rules() : options.rules;
  }

  function readDataRule(request: RouteRequest): DataRule | undefined {
    return typeof options.dataRule === 'function' ? options.dataRule(request) : options.dataRule;
  }

  function rememberAffinity(affinityId: string, targetKey: string): void {
    affinity.delete(affinityId); // re-adding moves it to the "newest" end
    affinity.set(affinityId, targetKey);
    while (affinity.size > maxAffinityEntries) {
      const oldest = affinity.keys().next();
      if (oldest.done === true) break;
      affinity.delete(oldest.value);
    }
  }

  function decide(request: RouteRequest): Decision {
    const label = purposeLabel(request.purpose);

    // Re-read the rows every time so a change by an administrator applies at once.
    const targets = new Map<string, RouteTarget>();
    for (const target of readTargets()) {
      if (!targets.has(target.key)) targets.set(target.key, target);
    }

    // Step 1: the rule. Several enabled rules for one purpose is a host mistake;
    // picking the lowest key keeps the outcome the same every time.
    const rule = readRules()
      .filter((candidate) => candidate.enabled !== false && candidate.purpose === request.purpose)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];

    if (rule === undefined) {
      return {
        plan: {
          purpose: request.purpose,
          candidates: [],
          order: [],
          sticky: false,
          explanation: `No model is available for ${label}: no routing rule for this purpose.`,
        },
        judged: [],
        targets,
        affinityId: undefined,
      };
    }

    const dataRule = readDataRule(request);
    const capabilities = [...new Set([...(rule.needs?.capabilities ?? []), ...(request.needs?.capabilities ?? [])])];
    const contextNeeds = [rule.needs?.minContextTokens, request.needs?.minContextTokens].filter(
      (value): value is number => value !== undefined,
    );
    const minContextTokens = contextNeeds.length > 0 ? Math.max(...contextNeeds) : undefined;

    // Step 2: walk the enabled steps in order and judge each one.
    const steps = rule.steps.filter((step) => step.enabled !== false).sort((a, b) => a.order - b.order);
    const isEmbed = request.purpose === 'embed';
    let routeSpace: string | undefined;
    const seen = new Set<string>();
    const judged: Judged[] = [];

    for (const step of steps) {
      // The same target listed twice adds nothing; only its first position counts.
      if (seen.has(step.targetKey)) continue;
      seen.add(step.targetKey);

      const target = targets.get(step.targetKey);
      if (target === undefined) {
        const verdict: Verdict = {
          dropped: 'unknown_target',
          detail: `no model is registered under the key "${step.targetKey}"`,
          aside: 'not in the model list',
          clause: 'is not in the model list',
        };
        judged.push({
          candidate: {
            targetKey: step.targetKey,
            providerId: '',
            modelId: '',
            order: step.order,
            eligible: false,
            dropped: verdict.dropped,
            detail: verdict.detail,
          },
          name: `"${step.targetKey}"`,
          verdict,
        });
        continue;
      }

      // Step 3: the first embedding model on the route fixes the vector space,
      // even if that model is unavailable right now. Anything stored earlier
      // was produced in that space, so nothing else may stand in for it.
      let spaces: JudgeContext['spaces'];
      if (isEmbed && target.kind === 'embedding') {
        const own = target.vectorSpace ?? target.modelId;
        if (routeSpace === undefined) routeSpace = own;
        spaces = { own, route: routeSpace };
      }

      const verdict = judgeTarget(target, {
        purpose: request.purpose,
        rule,
        dataRule,
        capabilities,
        minContextTokens,
        spaces,
        latencyMs: options.health?.(target.key)?.latencyMs ?? target.typicalLatencyMs,
        // Reading the state never uses up the trial call allowed after a cool-down.
        circuitState: breakers.get(target.key)?.state() ?? 'closed',
      });

      const position = judged.length + 1;
      judged.push({
        candidate: {
          targetKey: target.key,
          providerId: target.providerId,
          modelId: target.modelId,
          order: step.order,
          eligible: verdict === undefined,
          ...(verdict !== undefined ? { dropped: verdict.dropped } : {}),
          detail: verdict?.detail ?? `usable: ${choiceLabel(position)} for ${label}`,
        },
        name: targetName(target),
        ...(verdict !== undefined ? { verdict } : {}),
      });
    }

    // Step 4: stickiness. The affinity id includes the tenant and the rule so
    // one tenant's or one route's memory can never steer another's.
    let order = judged.filter((entry) => entry.candidate.eligible).map((entry) => entry.candidate.targetKey);
    const affinityId =
      rule.sticky !== false && request.affinityKey !== undefined
        ? JSON.stringify([request.tenantId ?? null, rule.key, request.affinityKey])
        : undefined;
    const remembered = affinityId === undefined ? undefined : affinity.get(affinityId);
    const sticky = remembered !== undefined && order.includes(remembered);
    if (sticky) order = [remembered, ...order.filter((key) => key !== remembered)];

    // Step 5: say it in plain English.
    const chosen = order[0];
    const chosenIndex = judged.findIndex((entry) => entry.candidate.targetKey === chosen);
    const chosenEntry = judged[chosenIndex];
    let explanation: string;
    if (chosenEntry !== undefined) {
      const why = sticky
        ? `it answered earlier in this run, so ${label} stays with it`
        : `${choiceLabel(chosenIndex + 1)} for ${label}`;
      explanation = `Sent to ${chosenEntry.name}: ${why}.${skippedSentence(judged)}`;
    } else if (judged.length === 0) {
      explanation = `No model is available for ${label}: the routing rule "${rule.key}" has no steps switched on.`;
    } else {
      const reasons = judged.flatMap((entry) => (entry.verdict ? [`${entry.name} ${entry.verdict.clause}`] : []));
      explanation = `No model is available for ${label}: ${joinClauses(reasons)}.`;
    }

    return {
      plan: {
        purpose: request.purpose,
        ruleKey: rule.key,
        candidates: judged.map((entry) => entry.candidate),
        order,
        ...(chosen !== undefined ? { chosen } : {}),
        sticky,
        ...(routeSpace !== undefined ? { vectorSpace: routeSpace } : {}),
        explanation,
      },
      judged,
      targets,
      affinityId,
    };
  }

  async function run<T>(
    request: RouteRequest,
    attempt: (target: RouteTarget, info: RouteAttemptInfo) => Promise<T>,
    opts?: RouteRunOptions,
  ): Promise<RouteOutcome<T>> {
    const decision = decide(request);
    const { plan, judged, targets, affinityId } = decision;
    const shouldFailOver = opts?.shouldFailOver ?? defaultShouldFailOver;
    const label = purposeLabel(request.purpose);
    const embedNote = request.purpose === 'embed' ? ` ${NOT_SENT_ELSEWHERE}` : '';
    const nameOf = (targetKey: string): string =>
      judged.find((entry) => entry.candidate.targetKey === targetKey)?.name ?? targetKey;
    const describe = (entry: RouteAttempt): string =>
      entry.skipped !== undefined
        ? `${nameOf(entry.targetKey)} was skipped (${PAUSED})`
        : `${nameOf(entry.targetKey)} failed (${failurePhrase(entry.errorCode)})`;

    if (plan.order.length === 0) {
      // A model that is only paused will come back by itself, so that case is
      // an outage worth retrying. Anything else needs an administrator.
      const onlyPaused = plan.candidates.some((candidate) => candidate.dropped === 'circuit_open');
      throw new WeaveIntelError({
        code: onlyPaused ? 'PROVIDER_ERROR' : 'INVALID_CONFIG',
        message: `${plan.explanation}${embedNote}`,
        retryable: onlyPaused,
        details: { plan, attempts: [] },
      });
    }

    const attempts: RouteAttempt[] = [];
    let attemptNumber = 0;

    for (const targetKey of plan.order) {
      const target = targets.get(targetKey);
      if (target === undefined) continue; // cannot happen: `order` only holds known targets

      // Ask the breaker only now, when a call is really about to be made.
      const breaker = breakerFor(targetKey);
      if (!breaker.canPass().allowed) {
        attempts.push({ targetKey, ok: false, skipped: 'circuit_open', errorCode: 'CIRCUIT_OPEN', durationMs: 0 });
        continue;
      }

      attemptNumber += 1;
      const startedAt = now();
      try {
        const value = await attempt(target, { attemptNumber, plan });
        breaker.recordSuccess();
        attempts.push({ targetKey, ok: true, durationMs: now() - startedAt });
        if (affinityId !== undefined) rememberAffinity(affinityId, targetKey);

        const earlier = attempts.slice(0, -1);
        const servedBy = nameOf(targetKey);
        let detour = '';
        const only = earlier[0];
        if (earlier.length === 1 && only !== undefined && only.skipped === undefined) {
          detour = ` Tried ${nameOf(only.targetKey)} first; it failed (${failurePhrase(only.errorCode)}), so the answer came from ${servedBy}.`;
        } else if (earlier.length > 0) {
          detour = ` ${joinList(earlier.map(describe))}, so the answer came from ${servedBy}.`;
        }
        return { value, target, plan, attempts, explanation: `${plan.explanation}${detour}` };
      } catch (error) {
        const errorCode = errorCodeOf(error);
        attempts.push({
          targetKey,
          ok: false,
          ...(errorCode !== undefined ? { errorCode } : {}),
          errorMessage: errorMessageOf(error),
          durationMs: now() - startedAt,
        });

        // A request that was invalid, cancelled, blocked or over budget says
        // nothing about the model's health, so it must not count towards
        // pausing the model for everyone else or break stickiness.
        const callerFault = errorCode !== undefined && CALLER_FAULT_CODES.has(errorCode);
        if (!callerFault) {
          breaker.recordFailure();
          if (affinityId !== undefined && affinity.get(affinityId) === targetKey) affinity.delete(affinityId);
        }

        if (!shouldFailOver(error)) throw error;
      }
    }

    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: `No model could answer for ${label}: ${joinList(attempts.map(describe))}.${skippedSentence(judged)}${embedNote}`,
      retryable: true,
      details: { plan, attempts },
    });
  }

  return {
    plan: (request) => decide(request).plan,
    run,
    health() {
      const keys = new Set<string>();
      for (const target of readTargets()) keys.add(target.key);
      for (const key of breakers.keys()) keys.add(key);
      return [...keys].map((targetKey) => {
        const snapshot = breakers.get(targetKey)?.snapshot();
        return {
          targetKey,
          state: snapshot?.state ?? 'closed',
          consecutiveFailures: snapshot?.consecutiveFailures ?? 0,
        };
      });
    },
    reset() {
      breakers.clear();
      affinity.clear();
    },
  };
}
