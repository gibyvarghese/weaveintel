/**
 * Kaggle role-specific task handlers — barrel.
 *
 * The actual role logic lives in `./handlers/<role>.ts`. This file just
 * resolves shared deps (adapter, log, lazy operational defaults) once and
 * composes the right handler map for the requested mode (agentic vs
 * deterministic). The mesh template (`mesh-template.ts`) drives which role
 * label each handler is bound to.
 *
 * THIS FILE INTENTIONALLY CONTAINS NO COMPETITION-SPECIFIC LOGIC.
 * - Agentic mode (LLM strategist): system prompt comes from the DB playbook
 *   resolved per inbound competition slug.
 * - Deterministic mode (no LLM): the implementer asks the playbook resolver
 *   for a Python solver template + strategy presets keyed off the discovered
 *   competition slug. If no playbook matches, the deterministic implementer
 *   reports back without pushing — i.e. operators must seed a playbook for
 *   any competition they want to drive deterministically.
 */

import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';
import {
  loadOperationalDefaults,
  noopHandler,
  type KaggleHandlerMap,
  type KaggleRoleHandlersOptions,
  type OperationalDefaults,
  type SharedHandlerContext,
} from './handlers/_shared.js';
import { createDiscovererAgentic, createDiscovererDeterministic } from './handlers/discoverer.js';
import {
  createStrategistAgenticWithHandoff,
  createStrategistDeterministic,
} from './handlers/strategist.js';
import { createImplementerDeterministic } from './handlers/implementer.js';
import { createValidatorAgentic, createValidatorDeterministic } from './handlers/validator.js';
import { createSubmitter } from './handlers/submitter.js';
import { createObserverAgentic, createObserverDeterministic } from './handlers/observer.js';
import { extractCompetitionSlugFromText } from './playbook-resolver.js';

export type { KaggleRoleHandlersOptions } from './handlers/_shared.js';

export function createKaggleRoleHandlers(opts: KaggleRoleHandlersOptions = {}): KaggleHandlerMap {
  const adapter = opts.adapter ?? liveKaggleAdapter;
  const log = opts.log ?? ((m: string) => console.log(`[kaggle-handler] ${m}`));

  // Lazy promise so we resolve the catch-all playbook exactly once and reuse.
  let opDefaultsPromise: Promise<OperationalDefaults> | null = null;
  const getOpDefaults = () => {
    if (!opDefaultsPromise) opDefaultsPromise = loadOperationalDefaults(opts.playbookResolver, log);
    return opDefaultsPromise;
  };

  const ctx: SharedHandlerContext = { opts, adapter, log, getOpDefaults };

  // ── AGENTIC MODE ──────────────────────────────────────────
  // Agentic mode is enabled when any of the following is configured:
  //   - `plannerModel` (startup-resolved pinned model)
  //   - `modelResolver` (Phase 1 first-class per-tick resolver)
  //   - `resolveModelForRole` (legacy callback, deprecated alias)
  // The strategist's wrapper picks between them per call.
  if (opts.plannerModel || opts.modelResolver || opts.resolveModelForRole) {
    return {
      'Competition Discoverer': createDiscovererAgentic(ctx),
      'Approach Ideator': createStrategistAgenticWithHandoff(ctx),
      'Kernel Author': noopHandler,
      'Submission Validator': opts.db ? createValidatorAgentic(ctx) : noopHandler,
      'Competition Submitter': createSubmitter(ctx),
      'Leaderboard Observer': opts.db ? createObserverAgentic(ctx) : noopHandler,
    };
  }

  // ── DETERMINISTIC MODE (no LLM, DB-driven) ───────────────
  return {
    'Competition Discoverer': createDiscovererDeterministic(ctx),
    'Approach Ideator': createStrategistDeterministic(ctx),
    'Kernel Author': createImplementerDeterministic(ctx),
    'Submission Validator': createValidatorDeterministic(ctx),
    'Competition Submitter': createSubmitter(ctx),
    'Leaderboard Observer': createObserverDeterministic(ctx),
  };
}

// Re-export the slug helper for callers that need to extract slugs from
// inbound text (e.g. examples or downstream tools).
export { extractCompetitionSlugFromText };
