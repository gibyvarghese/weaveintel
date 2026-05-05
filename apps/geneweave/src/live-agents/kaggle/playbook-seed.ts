/**
 * Seed Kaggle competition playbooks into GeneWeave DB.
 *
 * Idempotent. Inserts (or skips if present, by stable id):
 *   - prompt_fragments:
 *       kaggle.workflow.default_discovery  — catch-all generic discovery prompt
 *       kaggle.workflow.arc_agi_3          — verbatim ARC-AGI-3 strategist workflow
 *       kaggle.solver_template.arc_agi_3   — verbatim Python solver template
 *   - skills (category=kaggle_playbook):
 *       kaggle-playbook-default  — catch-all (`*`); instructions are a fragment ref
 *       kaggle-playbook-arc-agi-3 — matches `arc-prize-*`, `*arc-agi*`
 *
 * After seeding, ALL playbook content lives in the DB and is editable via
 * admin (skills + prompt fragments tabs). The runtime resolver
 * (playbook-resolver.ts) loads the matching playbook per competition slug
 * and expands `{{>...}}` fragment markers via `@weaveintel/prompts`.
 */

import type { DatabaseAdapter } from '../../db-types.js';
import {
  KAGGLE_ARC_AGI_3_WORKFLOW,
  KAGGLE_ARC_AGI_3_SOLVER_TEMPLATE,
  KAGGLE_DEFAULT_DISCOVERY,
  KAGGLE_ARC_STRATEGY_PRESETS,
} from './playbook-seed-content.js';
import { KAGGLE_PLAYBOOK_CATEGORY } from './playbook-resolver.js';

const FRAGMENT_ID_DEFAULT_DISCOVERY = 'frag-kaggle-workflow-default-discovery';
const FRAGMENT_KEY_DEFAULT_DISCOVERY = 'kaggle.workflow.default_discovery';
const FRAGMENT_ID_ARC_WORKFLOW = 'frag-kaggle-workflow-arc-agi-3';
const FRAGMENT_KEY_ARC_WORKFLOW = 'kaggle.workflow.arc_agi_3';
const FRAGMENT_ID_ARC_SOLVER = 'frag-kaggle-solver-template-arc-agi-3';
const FRAGMENT_KEY_ARC_SOLVER = 'kaggle.solver_template.arc_agi_3';

const SKILL_ID_DEFAULT = 'kaggle-playbook-default';
const SKILL_ID_ARC = 'kaggle-playbook-arc-agi-3';

const DEFAULT_PLAYBOOK_INSTRUCTIONS = `{{>${FRAGMENT_KEY_DEFAULT_DISCOVERY}}}`;
const ARC_PLAYBOOK_INSTRUCTIONS = `{{>${FRAGMENT_KEY_ARC_WORKFLOW}}}`;

/** Quietly insert a fragment if not present. */
async function ensureFragment(
  db: DatabaseAdapter,
  id: string,
  key: string,
  name: string,
  category: string,
  content: string,
): Promise<'inserted' | 'exists'> {
  const CURRENT_VERSION = '1.4.0';
  const existing = await db.getPromptFragment(id).catch(() => null);
  const byKey = existing ?? (await db.getPromptFragmentByKey(key).catch(() => null));
  if (byKey) {
    // Refresh content when the seeded version differs OR the bundled seed
    // content has changed under us. Operator-edited rows whose content has
    // already drifted from the seed are left alone (version stamp lets the
    // operator opt back in by resetting it to the bundled CURRENT_VERSION).
    if (byKey.version !== CURRENT_VERSION || byKey.content !== content) {
      try {
        await db.updatePromptFragment(byKey.id, { content, version: CURRENT_VERSION });
        return 'inserted';
      } catch {
        return 'exists';
      }
    }
    return 'exists';
  }
  await db.createPromptFragment({
    id,
    key,
    name,
    description: `Kaggle live-agents playbook fragment (${key}).`,
    category,
    content,
    variables: null,
    tags: JSON.stringify(['kaggle', 'live-agents', 'playbook']),
    version: CURRENT_VERSION,
    enabled: 1,
  });
  return 'inserted';
}

async function ensureSkill(
  db: DatabaseAdapter,
  row: {
    id: string;
    name: string;
    description: string;
    triggerPatterns: string[];
    instructions: string;
    toolNames: string[];
    examples: unknown;
    priority: number;
  },
): Promise<'inserted' | 'exists'> {
  const existing = await db.getSkill(row.id).catch(() => null);
  if (existing) return 'exists';
  await db.createSkill({
    id: row.id,
    name: row.name,
    description: row.description,
    category: KAGGLE_PLAYBOOK_CATEGORY,
    trigger_patterns: JSON.stringify(row.triggerPatterns),
    instructions: row.instructions,
    tool_names: JSON.stringify(row.toolNames),
    examples: JSON.stringify(row.examples),
    tags: JSON.stringify(['kaggle', 'live-agents', 'playbook']),
    priority: row.priority,
    version: '1.0.0',
    tool_policy_key: null,
    supervisor_agent_id: null,
    domain_sections: null,
    execution_contract: null,
    enabled: 1,
  });
  return 'inserted';
}

export interface SeedKaggleArcPlaybookResult {
  fragments: Record<string, 'inserted' | 'exists'>;
  skills: Record<string, 'inserted' | 'exists'>;
}

export async function seedKaggleArcPlaybook(
  db: DatabaseAdapter,
): Promise<SeedKaggleArcPlaybookResult> {
  const fragments: Record<string, 'inserted' | 'exists'> = {};
  fragments[FRAGMENT_KEY_DEFAULT_DISCOVERY] = await ensureFragment(
    db,
    FRAGMENT_ID_DEFAULT_DISCOVERY,
    FRAGMENT_KEY_DEFAULT_DISCOVERY,
    'Kaggle default discovery workflow',
    'kaggle',
    KAGGLE_DEFAULT_DISCOVERY,
  );
  fragments[FRAGMENT_KEY_ARC_WORKFLOW] = await ensureFragment(
    db,
    FRAGMENT_ID_ARC_WORKFLOW,
    FRAGMENT_KEY_ARC_WORKFLOW,
    'Kaggle ARC-AGI-3 strategist workflow',
    'kaggle',
    KAGGLE_ARC_AGI_3_WORKFLOW,
  );
  fragments[FRAGMENT_KEY_ARC_SOLVER] = await ensureFragment(
    db,
    FRAGMENT_ID_ARC_SOLVER,
    FRAGMENT_KEY_ARC_SOLVER,
    'Kaggle ARC-AGI-3 baseline solver template',
    'kaggle',
    KAGGLE_ARC_AGI_3_SOLVER_TEMPLATE,
  );

  const skills: Record<string, 'inserted' | 'exists'> = {};
  skills[SKILL_ID_DEFAULT] = await ensureSkill(db, {
    id: SKILL_ID_DEFAULT,
    name: 'Kaggle Playbook — Default',
    description:
      'Catch-all Kaggle playbook used when no competition-specific playbook matches the competition slug. Drives a generic identify-then-baseline workflow.',
    triggerPatterns: ['*'],
    instructions: DEFAULT_PLAYBOOK_INSTRUCTIONS,
    toolNames: [
      'kaggle_list_competitions',
      'kaggle_push_kernel',
      'kaggle_get_kernel_status',
      'kaggle_get_kernel_output',
    ],
    examples: {
      shape: 'unknown',
      maxIterations: 5,
      // Operational defaults applied across handlers. The catch-all `*`
      // playbook acts as the runtime config carrier so operators can edit
      // these in admin without touching code.
      topNAgentic: 5,
      topNDeterministic: 3,
      pollIntervalSec: 10,
      pollTimeoutSec: 300,
      kernelOutputHeadBytes: 4000,
      kernelOutputTailBytes: 4000,
      kernelWaitMaxTimeoutSec: 600,
      // Tier C: bridge + attention defaults. Operators tune these in admin
      // by editing the catch-all (`*`) skill's examples JSON.
      attentionRestMinutes: 60,
      bridgeTopics: [
        'kaggle.submission_result',
        'kaggle.rank_change',
        'kaggle.escalation_request',
      ],
      bridgeRateLimitPerHour: 100,
      bridgePurposeProse:
        'Surface Kaggle submission results, rank changes, and escalation requests to the user mesh; receive human approvals for dual-control gates.',
      // Tier D: capability matrix + dual-control gate. Operators tighten /
      // loosen these in admin without a deploy. Capability revocation takes
      // effect on the agent's next tick.
      capabilityMatrix: {
        discoverer: ['KAGGLE_LIST_COMPETITIONS', 'KAGGLE_READ_DATASETS'],
        strategist: ['KAGGLE_LIST_KERNELS', 'KAGGLE_READ_KERNELS'],
        implementer: ['KAGGLE_PUSH_KERNEL', 'KAGGLE_READ_KERNELS'],
        validator: ['KAGGLE_DOWNLOAD_DATA', 'KAGGLE_LOCAL_COMPUTE'],
        submitter: ['KAGGLE_SUBMIT'],
        observer: ['KAGGLE_READ_LEADERBOARD', 'KAGGLE_READ_SUBMISSIONS'],
      },
      dualControlRequiredFor: [
        'kaggle.competitions.submit',
        'kaggle.kernels.push',
      ],
      // Tier E: role personas + pipeline edges. Operators can rename roles,
      // tighten objectives, or rewire the pipeline (e.g. drop the observer)
      // entirely from admin without a code change.
      rolePersonas: {
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
      },
      pipelineEdges: [
        { from: 'discoverer', to: 'strategist', relationship: 'DIRECTS', prose: 'Discoverer hands picked competitions to the strategist.' },
        { from: 'strategist', to: 'implementer', relationship: 'DIRECTS', prose: 'Strategist hands approved approaches to the implementer.' },
        { from: 'implementer', to: 'validator', relationship: 'DIRECTS', prose: 'Implementer hands kernel outputs to the validator.' },
        { from: 'validator', to: 'submitter', relationship: 'DIRECTS', prose: 'Validator hands passing submissions to the submitter.' },
        { from: 'observer', to: 'strategist', relationship: 'COLLABORATES_WITH', prose: 'Observer surfaces leaderboard signal to the strategist.' },
      ],
    },
    priority: 0,
  });

  skills[SKILL_ID_ARC] = await ensureSkill(db, {
    id: SKILL_ID_ARC,
    name: 'Kaggle Playbook — ARC-AGI-3',
    description:
      'Competition-specific playbook for ARC Prize / ARC-AGI-3 (live-API agent competitions). Carries the v0.9.3 framework facts, action gating, 5-rung ladder and stop conditions.',
    triggerPatterns: ['arc-prize-*', '*arc-agi*'],
    instructions: ARC_PLAYBOOK_INSTRUCTIONS,
    toolNames: [
      'kaggle_list_competitions',
      'kaggle_push_kernel',
      'kaggle_get_kernel_status',
      'kaggle_get_kernel_output',
    ],
    examples: {
      shape: 'live_api',
      solverTemplateFragmentKey: FRAGMENT_KEY_ARC_SOLVER,
      strategyPresets: KAGGLE_ARC_STRATEGY_PRESETS,
      maxIterations: 8,
    },
    priority: 100,
  });

  return { fragments, skills };
}
