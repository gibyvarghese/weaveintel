/**
 * Phase K5 — Kaggle live-agents mesh template.
 *
 * Provisions the mesh, six role-bound agents, and per-role contracts described
 * in `docs/KAGGLE_AGENT_DESIGN.md` §5.1. The mesh enforces dual-control on the
 * two highest-risk MCP tools (`kaggle.competitions.submit`, `kaggle.kernels.push`).
 */

import type { AgentContract, LiveAgent, Mesh } from '@weaveintel/live-agents';
import type { KaggleAgentRole } from './account-bindings.js';

export interface KaggleMeshTemplateOptions {
  tenantId: string;
  /** Override mesh id (defaults to `mesh-kaggle-research-${tenantId}`). */
  meshId?: string;
  /** ISO timestamp used for createdAt on every entity. Defaults to `now()`. */
  nowIso?: string;
}

export interface KaggleMeshTemplate {
  mesh: Mesh;
  agents: Record<KaggleAgentRole, LiveAgent>;
  contracts: Record<KaggleAgentRole, AgentContract>;
}

const ROLE_PERSONAS: Record<KaggleAgentRole, { name: string; role: string; persona: string; objectives: string; success: string }> = {
  discoverer: {
    name: 'Kaggle Discoverer',
    role: 'Competition Discoverer',
    persona: 'Daily watch on the Kaggle catalog; surfaces high-fit competitions for the team.',
    objectives: 'Surface 1–3 candidate competitions per day with reward, deadline, and metric.',
    success: 'Each surfaced competition links to a Kaggle ref and includes deadline + evaluation metric.',
  },
  strategist: {
    name: 'Kaggle Strategist',
    role: 'Approach Ideator',
    persona: 'Proposes 2–3 modeling approaches per competition grounded in published kernels.',
    objectives: 'For each picked competition, propose distinct approaches with expected metric and rationale.',
    success: 'Each approach cites at least one source kernel and an expected metric range.',
  },
  implementer: {
    name: 'Kaggle Implementer',
    role: 'Kernel Author',
    persona: 'Builds notebook source from approved approaches and pushes to Kaggle as private kernels.',
    objectives: 'Push kernel; poll until status=complete; record kernel ref + output url.',
    success: 'Kernel pushes succeed at least 90% on first attempt; failures triage within one tick.',
  },
  validator: {
    name: 'Kaggle Validator',
    role: 'Submission Validator',
    persona: 'Runs deterministic header/row/id checks on submission CSVs before they reach the submitter.',
    objectives: 'Block any submission that fails header/row/id parity against the competition sample.',
    success: 'Zero malformed submissions reach the submitter.',
  },
  submitter: {
    name: 'Kaggle Submitter',
    role: 'Competition Submitter',
    persona: 'Final gate: requires dual-control approval before calling kaggle.competitions.submit.',
    objectives: 'Submit only validated entries; respect 4/day/competition cap.',
    success: 'No more than 4 submissions per competition per UTC day; every submission has a paired Promotion.',
  },
  observer: {
    name: 'Kaggle Observer',
    role: 'Leaderboard Observer',
    persona: 'Hourly poll of leaderboard + own submissions; flags rank drops to the strategist.',
    objectives: 'Detect rank drops > N positions and surface to strategist within one tick.',
    success: 'Rank-drop notices reach strategist before the next discoverer tick.',
  },
};

function makeContract(args: {
  agentId: string;
  role: KaggleAgentRole;
  contractVersionId: string;
  attentionPolicyRef: string;
  nowIso: string;
}): AgentContract {
  const cfg = ROLE_PERSONAS[args.role];
  return {
    id: args.contractVersionId,
    agentId: args.agentId,
    version: 1,
    persona: cfg.persona,
    objectives: cfg.objectives,
    successIndicators: cfg.success,
    budget: { monthlyUsdCap: 200, perActionUsdCap: 5 },
    workingHoursSchedule: { timezone: 'UTC', cronActive: '* * * * *' },
    accountBindingRefs: [],
    attentionPolicyRef: args.attentionPolicyRef,
    reviewCadence: 'P1D',
    contextPolicy: {
      compressors: [],
      weighting: [],
      budgets: {
        attentionTokensMax: 2000,
        actionTokensMax: 1500,
        handoffTokensMax: 800,
        reportTokensMax: 600,
        monthlyCompressionUsdCap: 10,
      },
      defaultsProfile: 'knowledge-worker',
    },
    createdAt: args.nowIso,
  };
}

/** Build (but do not persist) the mesh + agents + contracts. */
export function buildKaggleMeshTemplate(opts: KaggleMeshTemplateOptions): KaggleMeshTemplate {
  const tenantId = opts.tenantId;
  const meshId = opts.meshId ?? `mesh-kaggle-research-${tenantId}`;
  const nowIso = opts.nowIso ?? new Date().toISOString();

  const mesh: Mesh = {
    id: meshId,
    tenantId,
    name: 'Kaggle Research Mesh',
    charter: 'Discover, ideate, implement, validate, submit, and observe Kaggle competition entries.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['kaggle.competitions.submit', 'kaggle.kernels.push'],
    createdAt: nowIso,
  };

  const roles: KaggleAgentRole[] = ['discoverer', 'strategist', 'implementer', 'validator', 'submitter', 'observer'];

  const agents = {} as Record<KaggleAgentRole, LiveAgent>;
  const contracts = {} as Record<KaggleAgentRole, AgentContract>;
  for (const role of roles) {
    const agentId = `${meshId}::${role}`;
    const contractVersionId = `${agentId}::contract-v1`;
    agents[role] = {
      id: agentId,
      meshId,
      name: ROLE_PERSONAS[role].name,
      role: ROLE_PERSONAS[role].role,
      contractVersionId,
      status: 'ACTIVE',
      createdAt: nowIso,
      archivedAt: null,
    };
    contracts[role] = makeContract({
      agentId,
      role,
      contractVersionId,
      attentionPolicyRef: `kaggle-${role}`,
      nowIso,
    });
  }

  return { mesh, agents, contracts };
}
