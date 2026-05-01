/**
 * Seed Kaggle competition playbooks into GeneWeave DB.
 *
 * Idempotent. Inserts (or skips if present, by stable id):
 *   - prompt_fragments:
 *       kaggle.workflow.arc_agi_3      — verbatim ARC-AGI-3 strategist workflow
 *       kaggle.solver_template.arc_agi_3 — verbatim Python solver template
 *   - skills (category=kaggle_playbook):
 *       kaggle-playbook-default  — catch-all (`*`), generic discovery prompt
 *       kaggle-playbook-arc-agi-3 — matches `arc-prize-*`, `*arc-agi*`
 *
 * After seeding, all ARC-specific content lives in the DB and can be edited
 * via admin (skills + prompt fragments tabs). The runtime resolver
 * (playbook-resolver.ts) loads the matching playbook per competition slug.
 */

import type { DatabaseAdapter } from '../../db-types.js';
import {
  KAGGLE_ARC_AGI_3_WORKFLOW,
  KAGGLE_ARC_AGI_3_SOLVER_TEMPLATE,
} from './playbook-seed-content.js';
import { KAGGLE_PLAYBOOK_CATEGORY } from './playbook-resolver.js';

const FRAGMENT_ID_ARC_WORKFLOW = 'frag-kaggle-workflow-arc-agi-3';
const FRAGMENT_KEY_ARC_WORKFLOW = 'kaggle.workflow.arc_agi_3';
const FRAGMENT_ID_ARC_SOLVER = 'frag-kaggle-solver-template-arc-agi-3';
const FRAGMENT_KEY_ARC_SOLVER = 'kaggle.solver_template.arc_agi_3';

const SKILL_ID_DEFAULT = 'kaggle-playbook-default';
const SKILL_ID_ARC = 'kaggle-playbook-arc-agi-3';

const GENERIC_DISCOVERY_INSTRUCTIONS = `You are a Kaggle Grandmaster running an autonomous research loop on a competition you have not yet identified.

Mission: figure out which competition this is, what shape it is, then either dispatch to a competition-specific playbook (if the operator has seeded one in the database) or build a minimal-but-valid baseline entry yourself.

Workflow:

  ITERATION 1 — Identify the competition.
    - List active competitions with kaggle_list_competitions and pick the most tractable.
    - Push a tiny scout kernel attached to it whose only job is to:
        * os.walk(/kaggle/input) and print the first 500 paths.
        * cat any README.md, llms.txt, sample_submission.* (truncate each to 1500 chars).
        * Print "AGENT_RESULT: status=ok competitionId=<slug> shape=<static_files|live_api|unknown> notes=<short>".
    - Read the kernel log. Now you KNOW the competition slug and shape.

  ITERATION 2+ — If the operator has registered a competition-specific playbook for this slug, the next strategist tick will be re-prompted with the playbook's specialized instructions. Otherwise:
    - For shape=static_files: write code that loads /kaggle/input/<slug>/, trains a simple but valid baseline for the evaluation metric, writes the required submission file.
    - For shape=live_api: identify the framework directory and use its high-level API directly — DO NOT import internal agents/ packages (they pull heavy optional deps not in wheels).
    - In either case: push under a distinct kernel slug per attempt; read the full log; iterate up to 5 attempts.

Stop when the kernel produces a valid entry (status=complete + expected output file). DO NOT submit to the leaderboard — submission is gated on a separate human approval step.

Constraints:
  - Standard Kaggle Python image only. No PyPI internet.
  - Each kernel under 5 minutes.
  - Distinct kernel slugs per attempt.
  - DO NOT call any submit-style tool — there isn't one.`;

const ARC_PLAYBOOK_INSTRUCTIONS = `{{>${FRAGMENT_KEY_ARC_WORKFLOW}}}`;

const ARC_STRATEGY_PRESETS = [
  {
    label: 'baseline-all-transforms',
    variables: {
      STRATEGY_FLAGS_PY: '{\n    "identity": True,\n    "rot90": True,\n    "rot180": True,\n    "rot270": True,\n    "flip_h": True,\n    "flip_v": True,\n    "transpose": True,\n    "color_perm": True,\n}',
      ITERATION_NUMBER: 1,
      RUN_LABEL: 'baseline-all-transforms',
    },
  },
  {
    label: 'rotations-only',
    variables: {
      STRATEGY_FLAGS_PY: '{\n    "identity": True,\n    "rot90": True,\n    "rot180": True,\n    "rot270": True,\n    "flip_h": False,\n    "flip_v": False,\n    "transpose": False,\n    "color_perm": False,\n}',
      ITERATION_NUMBER: 2,
      RUN_LABEL: 'rotations-only',
    },
  },
  {
    label: 'identity-plus-color-perm',
    variables: {
      STRATEGY_FLAGS_PY: '{\n    "identity": True,\n    "rot90": False,\n    "rot180": False,\n    "rot270": False,\n    "flip_h": False,\n    "flip_v": False,\n    "transpose": False,\n    "color_perm": True,\n}',
      ITERATION_NUMBER: 3,
      RUN_LABEL: 'identity-plus-color-perm',
    },
  },
];

/** Quietly insert a fragment if not present. */
async function ensureFragment(
  db: DatabaseAdapter,
  id: string,
  key: string,
  name: string,
  category: string,
  content: string,
): Promise<'inserted' | 'exists'> {
  const existing = await db.getPromptFragment(id).catch(() => null);
  if (existing) return 'exists';
  // Also dedupe by key in case row exists with a different id.
  const byKey = await db.getPromptFragmentByKey(key).catch(() => null);
  if (byKey) return 'exists';
  await db.createPromptFragment({
    id,
    key,
    name,
    description: `Kaggle live-agents playbook fragment (${key}).`,
    category,
    content,
    variables: null,
    tags: JSON.stringify(['kaggle', 'live-agents', 'playbook']),
    version: '1.0.0',
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
    instructions: GENERIC_DISCOVERY_INSTRUCTIONS,
    toolNames: [
      'kaggle_list_competitions',
      'kaggle_push_kernel',
      'kaggle_get_kernel_status',
      'kaggle_get_kernel_output',
    ],
    examples: {
      shape: 'unknown',
      maxIterations: 5,
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
      strategyPresets: ARC_STRATEGY_PRESETS,
      maxIterations: 8,
    },
    priority: 100,
  });

  return { fragments, skills };
}
