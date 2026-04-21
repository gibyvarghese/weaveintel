/**
 * Example 21 — Scientific Validation (Fakes-only, CI-safe)
 *
 * Demonstrates the full Scientific Validation workflow using only fake
 * models and an in-memory DB. No API keys or running server required.
 * Safe to run in CI.
 *
 * What this example shows:
 *  1. Constructing an SVWorkflowRunner with weaveFakeModel instances
 *  2. Submitting a hypothesis via runner.startRun()
 *  3. Inspecting the emitted verdict and sub-claims from the fake DB
 *  4. Cancelling an in-progress run (compensation pattern)
 *  5. Confirming verdict labels for three different hypothesis types:
 *     known-true, known-false, ill-posed
 *
 * Run:
 *   FAKE_CONTAINER_RUNTIME=1 npx ts-node examples/21-scientific-validation.ts
 */

import { weaveFakeModel } from '@weaveintel/testing';
import { SVWorkflowRunner, resetSVRunner } from '../apps/geneweave/src/features/scientific-validation/index.js';
import type {
  SvHypothesisRow,
  SvSubClaimRow,
  SvVerdictRow,
  SvEvidenceEventRow,
  SvAgentTurnRow,
  SvHypothesisStatus,
  SvBudgetEnvelopeRow,
  PromptRow,
} from '../apps/geneweave/src/db-types.js';
import type { DatabaseAdapter } from '../apps/geneweave/src/db.js';
import { createSVToolMap } from '../apps/geneweave/src/features/scientific-validation/tools/index.js';
import type { Tool } from '@weaveintel/core';

process.env['FAKE_CONTAINER_RUNTIME'] = '1';

// ── In-memory fake DB ────────────────────────────────────────────────────────

function createFakeDb() {
  const hypotheses = new Map<string, SvHypothesisRow>();
  const verdictsByHypothesis = new Map<string, SvVerdictRow>();
  const subClaims: SvSubClaimRow[] = [];
  const evidence: SvEvidenceEventRow[] = [];
  const turns: SvAgentTurnRow[] = [];

  const db: Partial<DatabaseAdapter> = {
    async getPromptByKey(_key: string): Promise<PromptRow | null> { return null; },
    async createHypothesis(h: Omit<SvHypothesisRow, 'created_at' | 'updated_at'>): Promise<void> {
      const now = new Date().toISOString();
      hypotheses.set(h.id, { ...h, created_at: now, updated_at: now } as SvHypothesisRow);
    },
    async getHypothesis(id: string): Promise<SvHypothesisRow | null> {
      return hypotheses.get(id) ?? null;
    },
    async updateHypothesisStatus(id: string, status: SvHypothesisStatus): Promise<void> {
      const row = hypotheses.get(id);
      if (row) hypotheses.set(id, { ...row, status, updated_at: new Date().toISOString() });
    },
    async createSubClaim(sc: Omit<SvSubClaimRow, 'created_at'>): Promise<void> {
      subClaims.push({ ...sc, created_at: new Date().toISOString() });
    },
    async listSubClaims(hypothesisId: string): Promise<SvSubClaimRow[]> {
      return subClaims.filter((s) => s.hypothesis_id === hypothesisId);
    },
    async createVerdict(v: Omit<SvVerdictRow, 'created_at'>): Promise<void> {
      verdictsByHypothesis.set(v.hypothesis_id, { ...v, created_at: new Date().toISOString() });
    },
    async getVerdictByHypothesis(hypothesisId: string): Promise<SvVerdictRow | null> {
      return verdictsByHypothesis.get(hypothesisId) ?? null;
    },
    async getVerdictById(id: string): Promise<SvVerdictRow | null> {
      for (const v of verdictsByHypothesis.values()) {
        if (v.id === id) return v;
      }
      return null;
    },
    async createEvidenceEvent(e: Omit<SvEvidenceEventRow, 'created_at'>): Promise<void> {
      evidence.push({ ...e, created_at: new Date().toISOString() });
    },
    async listEvidenceEvents(hypothesisId: string): Promise<SvEvidenceEventRow[]> {
      return evidence.filter((e) => e.hypothesis_id === hypothesisId);
    },
    async createAgentTurn(t: Omit<SvAgentTurnRow, 'created_at'>): Promise<void> {
      turns.push({ ...t, created_at: new Date().toISOString() });
    },
    async listAgentTurns(hypothesisId: string): Promise<SvAgentTurnRow[]> {
      return turns.filter((t) => t.hypothesis_id === hypothesisId);
    },
    async getAgentTurnsSince(hypothesisId: string): Promise<SvAgentTurnRow[]> {
      return turns.filter((t) => t.hypothesis_id === hypothesisId);
    },
    async getEvidenceEventsSince(hypothesisId: string): Promise<SvEvidenceEventRow[]> {
      return evidence.filter((e) => e.hypothesis_id === hypothesisId);
    },
    async getBudgetEnvelope(): Promise<SvBudgetEnvelopeRow | null> { return null; },
    async createBudgetEnvelope(): Promise<void> {},
  };

  return { db, hypotheses, verdictsByHypothesis, subClaims, evidence, turns };
}

// ── Canned supervisor responses ──────────────────────────────────────────────

const SUPERVISOR_SUPPORTED = JSON.stringify({
  verdict: 'SUPPORTED',
  confidence: 0.85,
  summary: 'Strong RCT evidence with consistent effect sizes across populations.',
});

const SUPERVISOR_REFUTED = JSON.stringify({
  verdict: 'CONTRADICTED',
  confidence: 0.93,
  summary: 'No physical mechanism plausible. All RCTs show placebo-only effects.',
});

const SUPERVISOR_INCONCLUSIVE = JSON.stringify({
  verdict: 'INSUFFICIENT_EVIDENCE',
  confidence: 0.51,
  summary: 'Hypothesis lacks an agreed operational definition and is not empirically testable.',
});

// ── Runner factory ───────────────────────────────────────────────────────────

function buildRunner(db: Partial<DatabaseAdapter>, supervisorResponse: string): SVWorkflowRunner {
  const decomposerJson = JSON.stringify({
    subClaims: [{
      statement: 'A measurable physiological change occurs following the intervention.',
      claimType: 'mechanism',
      testabilityScore: 0.88,
      rationale: 'Can be measured via validated clinical endpoints.',
    }],
  });

  const reasoningModel = weaveFakeModel({
    responses: [
      decomposerJson,
      'Evidence reviewed. Some confounders noted.',   // adversarial
      supervisorResponse,                              // supervisor
    ],
  });

  const toolModel = weaveFakeModel({
    responses: [
      'Literature search complete. 12 papers found.',  // literature
      'Statistical meta-analysis complete.',           // statistical
      'Mathematical model is internally consistent.',  // mathematical
      'Simulation convergence achieved at 87%.',       // simulation
    ],
  });

  let toolMap: Record<string, Tool> = {};
  try { toolMap = createSVToolMap(); } catch { /* use empty map in CI */ }

  return new SVWorkflowRunner({
    db: db as DatabaseAdapter,
    makeReasoningModel: async () => reasoningModel,
    makeToolModel: async () => toolModel,
    toolMap,
  });
}

function seedHypothesis(
  hypotheses: Map<string, SvHypothesisRow>,
  id: string,
  statement: string,
): void {
  const now = new Date().toISOString();
  hypotheses.set(id, {
    id,
    tenant_id: 'tenant-example',
    submitted_by: 'user-example',
    title: 'Example hypothesis',
    statement,
    domain_tags: '[]',
    status: 'queued',
    budget_envelope_id: 'budget-example',
    workflow_run_id: null,
    trace_id: 'trace-example',
    contract_id: 'contract-example',
    created_at: now,
    updated_at: now,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Scientific Validation — Fakes-only Example ===\n');

  // ── 1. Known-true hypothesis ──────────────────────────────────────────────
  console.log('── Scenario 1: Known-true hypothesis ──');
  {
    const { db, hypotheses, verdictsByHypothesis, subClaims } = createFakeDb();
    const id = 'hyp-aerobic-001';
    seedHypothesis(hypotheses, id,
      'Regular aerobic exercise (≥150 min/week) significantly improves cardiovascular health markers.');

    const runner = buildRunner(db, SUPERVISOR_SUPPORTED);
    await runner.startRun({
      hypothesisId: id,
      tenantId: 'tenant-example',
      userId: 'user-example',
      statement: 'Regular aerobic exercise improves cardiovascular health markers.',
      domainTags: ['cardiology', 'exercise-science'],
      budgetId: 'budget-example',
    });

    const hyp = hypotheses.get(id)!;
    const verdict = verdictsByHypothesis.get(id)!;
    const sc = subClaims.filter((s) => s.hypothesis_id === id);

    console.log(`  Status   : ${hyp.status}`);
    console.log(`  Verdict  : ${verdict.verdict}`);
    console.log(`  Summary  : ${verdict.summary_text}`);
    console.log(`  Sub-claims decomposed: ${sc.length}`);
    console.log(`  Contract ID : ${verdict.contract_id}`);
    console.log();
    resetSVRunner();
  }

  // ── 2. Known-false hypothesis ─────────────────────────────────────────────
  console.log('── Scenario 2: Known-false hypothesis ──');
  {
    const { db, hypotheses, verdictsByHypothesis } = createFakeDb();
    const id = 'hyp-homeopathy-001';
    seedHypothesis(hypotheses, id,
      'Homeopathic dilutions retain a memory of dissolved substances and produce measurable effects.');

    const runner = buildRunner(db, SUPERVISOR_REFUTED);
    await runner.startRun({
      hypothesisId: id,
      tenantId: 'tenant-example',
      userId: 'user-example',
      statement: 'Homeopathic dilutions produce effects beyond placebo.',
      domainTags: ['pharmacology'],
      budgetId: 'budget-example',
    });

    const hyp = hypotheses.get(id)!;
    const verdict = verdictsByHypothesis.get(id)!;

    console.log(`  Status  : ${hyp.status}`);
    console.log(`  Verdict : ${verdict.verdict}`);
    console.log(`  Summary : ${verdict.summary_text}`);
    console.log();
    resetSVRunner();
  }

  // ── 3. Ill-posed hypothesis ───────────────────────────────────────────────
  console.log('── Scenario 3: Ill-posed hypothesis ──');
  {
    const { db, hypotheses, verdictsByHypothesis } = createFakeDb();
    const id = 'hyp-consciousness-001';
    seedHypothesis(hypotheses, id,
      'Consciousness is a fundamental, irreducible property present in all matter.');

    const runner = buildRunner(db, SUPERVISOR_INCONCLUSIVE);
    await runner.startRun({
      hypothesisId: id,
      tenantId: 'tenant-example',
      userId: 'user-example',
      statement: 'Consciousness is a fundamental property of the universe.',
      domainTags: ['philosophy-of-mind'],
      budgetId: 'budget-example',
    });

    const hyp = hypotheses.get(id)!;
    const verdict = verdictsByHypothesis.get(id)!;

    console.log(`  Status  : ${hyp.status}`);
    console.log(`  Verdict : ${verdict.verdict}`);
    console.log(`  Summary : ${verdict.summary_text}`);
    console.log();
    resetSVRunner();
  }

  // ── 4. Compensation — cancel a run ────────────────────────────────────────
  console.log('── Scenario 4: Compensation — cancel a run ──');
  {
    const { db, hypotheses } = createFakeDb();
    const id = 'hyp-cancel-001';
    seedHypothesis(hypotheses, id, 'A hypothesis that will be cancelled before completion.');

    const runner = buildRunner(db, SUPERVISOR_SUPPORTED);

    // Cancel immediately — no startRun called
    await runner.cancelRun(id);

    const hyp = hypotheses.get(id)!;
    console.log(`  Status after cancel: ${hyp.status}`);
    console.log();
    resetSVRunner();
  }

  console.log('=== All scenarios complete ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
