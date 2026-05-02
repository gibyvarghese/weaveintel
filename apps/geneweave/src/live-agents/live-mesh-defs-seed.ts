/**
 * First-run seed for framework-level live mesh / agent definitions.
 *
 * Moves what used to live as in-code constants (ROLE_PERSONAS, PIPELINE_EDGES
 * inside `apps/geneweave/src/live-agents/kaggle/*`) into the new
 * `live_mesh_definitions` / `live_agent_definitions` /
 * `live_mesh_delegation_edges` tables. After this seeds once, operators edit
 * personas + pipeline shape from the admin UI; bootKaggleMesh loads the
 * snapshot at provision time.
 *
 * Idempotent: a per-mesh_key short-circuit guards re-seeding. Operator edits
 * to existing rows are never overwritten.
 */
import type { DatabaseAdapter } from '../db.js';
import { newUUIDv7 } from '../lib/uuid.js';

interface SeedAgent {
  role_key: string;
  name: string;
  role_label: string;
  persona: string;
  objectives: string;
  success_indicators: string;
  ordering: number;
}

interface SeedEdge {
  from_role_key: string;
  to_role_key: string;
  relationship: 'DIRECTS' | 'COLLABORATES_WITH' | 'REPORTS_TO';
  prose: string;
  ordering: number;
}

interface SeedMesh {
  mesh_key: string;
  name: string;
  charter_prose: string;
  dual_control_required_for: string[];
  description: string;
  agents: SeedAgent[];
  edges: SeedEdge[];
}

const KAGGLE_SEED: SeedMesh = {
  mesh_key: 'kaggle',
  name: 'Kaggle Research Mesh',
  charter_prose: 'Daily Kaggle competition discovery → strategy → kernel push → submission validation → submit, with leaderboard observation looping back to strategy.',
  dual_control_required_for: ['kaggle.competitions.submit', 'kaggle.kernels.push'],
  description: 'Default Kaggle research mesh seeded on first boot. Edit personas + pipeline edges below to adjust role behavior; runtime boot loads this snapshot.',
  agents: [
    {
      role_key: 'discoverer',
      name: 'Kaggle Discoverer',
      role_label: 'Competition Discoverer',
      persona: 'Daily watch on the Kaggle catalog; surfaces high-fit competitions for the team.',
      objectives: 'Surface 1–3 candidate competitions per day with reward, deadline, and metric.',
      success_indicators: 'Each surfaced competition links to a Kaggle ref and includes deadline + evaluation metric.',
      ordering: 10,
    },
    {
      role_key: 'strategist',
      name: 'Kaggle Strategist',
      role_label: 'Approach Ideator',
      persona: 'Proposes 2–3 modeling approaches per competition grounded in published kernels.',
      objectives: 'For each picked competition, propose distinct approaches with expected metric and rationale.',
      success_indicators: 'Each approach cites at least one source kernel and an expected metric range.',
      ordering: 20,
    },
    {
      role_key: 'implementer',
      name: 'Kaggle Implementer',
      role_label: 'Kernel Author',
      persona: 'Builds notebook source from approved approaches and pushes to Kaggle as private kernels.',
      objectives: 'Push kernel; poll until status=complete; record kernel ref + output url.',
      success_indicators: 'Kernel pushes succeed at least 90% on first attempt; failures triage within one tick.',
      ordering: 30,
    },
    {
      role_key: 'validator',
      name: 'Kaggle Validator',
      role_label: 'Submission Validator',
      persona: 'Runs deterministic header/row/id checks on submission CSVs before they reach the submitter.',
      objectives: 'Block any submission that fails header/row/id parity against the competition sample.',
      success_indicators: 'Zero malformed submissions reach the submitter.',
      ordering: 40,
    },
    {
      role_key: 'submitter',
      name: 'Kaggle Submitter',
      role_label: 'Competition Submitter',
      persona: 'Final gate: requires dual-control approval before calling kaggle.competitions.submit.',
      objectives: 'Submit only validated entries; respect 4/day/competition cap.',
      success_indicators: 'No more than 4 submissions per competition per UTC day; every submission has a paired Promotion.',
      ordering: 50,
    },
    {
      role_key: 'observer',
      name: 'Kaggle Observer',
      role_label: 'Leaderboard Observer',
      persona: 'Hourly poll of leaderboard + own submissions; flags rank drops to the strategist.',
      objectives: 'Detect rank drops > N positions and surface to strategist within one tick.',
      success_indicators: 'Rank-drop notices reach strategist before the next discoverer tick.',
      ordering: 60,
    },
  ],
  edges: [
    { from_role_key: 'discoverer',  to_role_key: 'strategist',  relationship: 'DIRECTS',           prose: 'Discoverer hands picked competitions to the strategist.',   ordering: 10 },
    { from_role_key: 'strategist',  to_role_key: 'implementer', relationship: 'DIRECTS',           prose: 'Strategist hands approved approaches to the implementer.', ordering: 20 },
    { from_role_key: 'implementer', to_role_key: 'validator',   relationship: 'DIRECTS',           prose: 'Implementer hands kernel outputs to the validator.',       ordering: 30 },
    { from_role_key: 'validator',   to_role_key: 'submitter',   relationship: 'DIRECTS',           prose: 'Validator hands passing submissions to the submitter.',    ordering: 40 },
    { from_role_key: 'observer',    to_role_key: 'strategist',  relationship: 'COLLABORATES_WITH', prose: 'Observer surfaces leaderboard signal to the strategist.',  ordering: 50 },
  ],
};

/**
 * Seed the framework-level Kaggle mesh definition on first boot. Idempotent.
 * Subsequent boots skip seeding to preserve operator edits.
 */
export async function seedLiveMeshDefinitions(db: DatabaseAdapter): Promise<void> {
  await seedOneMesh(db, KAGGLE_SEED);
}

async function seedOneMesh(db: DatabaseAdapter, seed: SeedMesh): Promise<void> {
  const existing = await db.getLiveMeshDefinitionByKey(seed.mesh_key);
  if (existing) return;

  const mesh = await db.createLiveMeshDefinition({
    id: newUUIDv7(),
    mesh_key: seed.mesh_key,
    name: seed.name,
    charter_prose: seed.charter_prose,
    dual_control_required_for: JSON.stringify(seed.dual_control_required_for),
    enabled: 1,
    description: seed.description,
  });

  for (const a of seed.agents) {
    await db.createLiveAgentDefinition({
      id: newUUIDv7(),
      mesh_def_id: mesh.id,
      role_key: a.role_key,
      name: a.name,
      role_label: a.role_label,
      persona: a.persona,
      objectives: a.objectives,
      success_indicators: a.success_indicators,
      ordering: a.ordering,
      enabled: 1,
    });
  }

  for (const e of seed.edges) {
    await db.createLiveMeshDelegationEdge({
      id: newUUIDv7(),
      mesh_def_id: mesh.id,
      from_role_key: e.from_role_key,
      to_role_key: e.to_role_key,
      relationship: e.relationship,
      prose: e.prose,
      ordering: e.ordering,
      enabled: 1,
    });
  }
}
