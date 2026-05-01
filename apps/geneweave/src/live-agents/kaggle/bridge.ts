/**
 * Phase K5 — Kaggle CrossMeshBridge wiring.
 *
 * Per design §5.1, the kaggle research mesh bridges to the user's main mesh on
 * three topics: submission_result, rank_change, escalation_request. The user
 * mesh sees notifications and provides human approvals for dual-control gates.
 */

import type { CrossMeshBridge } from '@weaveintel/live-agents';

export interface KaggleBridgeOptions {
  fromMeshId: string;
  toMeshId: string;
  authorisedByHumanId: string;
  coAuthorisedByHumanId?: string | null;
  nowIso?: string;
  bridgeId?: string;
}

export const KAGGLE_BRIDGE_TOPICS = [
  'kaggle.submission_result',
  'kaggle.rank_change',
  'kaggle.escalation_request',
] as const;

export function buildKaggleBridge(opts: KaggleBridgeOptions): CrossMeshBridge {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  return {
    id: opts.bridgeId ?? `bridge-kaggle-${opts.fromMeshId}-${opts.toMeshId}`,
    fromMeshId: opts.fromMeshId,
    toMeshId: opts.toMeshId,
    allowedAgentPairs: null,
    allowedTopics: [...KAGGLE_BRIDGE_TOPICS],
    rateLimitPerHour: 100,
    authorisedByType: 'HUMAN',
    authorisedById: opts.authorisedByHumanId,
    coAuthorisedByType: opts.coAuthorisedByHumanId ? 'HUMAN' : null,
    coAuthorisedById: opts.coAuthorisedByHumanId ?? null,
    effectiveFrom: nowIso,
    effectiveTo: null,
    revokedAt: null,
    purposeProse: 'Surface Kaggle submission results, rank changes, and escalation requests to the user mesh; receive human approvals for dual-control gates.',
    constraintsProse: `Topics: ${KAGGLE_BRIDGE_TOPICS.join(', ')}. Rate-limited to 100/hour.`,
  };
}
