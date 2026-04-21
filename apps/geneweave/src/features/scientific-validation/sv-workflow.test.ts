/**
 * Scientific Validation — Workflow Integration Tests
 *
 * End-to-end integration tests for the full SV workflow using:
 *  - weaveFakeModel with canned responses per agent step
 *  - An in-memory fake DatabaseAdapter (no real SQLite)
 *  - createSVToolMap() with FAKE_CONTAINER_RUNTIME=1
 *
 * Three canned hypotheses are exercised:
 *  1. known-true  — aerobic exercise / cardiovascular → verdict 'supported'
 *  2. known-false — homeopathy dilution memory → verdict 'refuted'
 *  3. ill-posed   — consciousness as fundamental property → verdict 'inconclusive'
 *
 * Compensation tests verify that cancellation at any point marks the
 * hypothesis as 'abandoned' and leaves DB in a clean state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { weaveFakeModel } from '@weaveintel/testing';
import type {
  SvHypothesisRow,
  SvSubClaimRow,
  SvVerdictRow,
  SvEvidenceEventRow,
  SvAgentTurnRow,
  SvHypothesisStatus,
  SvBudgetEnvelopeRow,
  PromptRow,
} from '../../db-types.js';
import type { DatabaseAdapter } from '../../db.js';
import { SVWorkflowRunner, resetSVRunner } from './runner.js';
import { createSVToolMap } from './tools/index.js';
import type { Tool } from '@weaveintel/core';

// ── Fake DB ─────────────────────────────────────────────────────────────────

/** Minimal in-memory DatabaseAdapter stub for SV integration tests. */
function createFakeDb(): Partial<DatabaseAdapter> & {
  hypotheses: Map<string, SvHypothesisRow>;
  verdicts: Map<string, SvVerdictRow>;
  subClaims: SvSubClaimRow[];
  evidence: SvEvidenceEventRow[];
  turns: SvAgentTurnRow[];
} {
  const hypotheses = new Map<string, SvHypothesisRow>();
  const verdicts = new Map<string, SvVerdictRow>();   // keyed by verdict id
  const verdictsByHypothesis = new Map<string, SvVerdictRow>(); // keyed by hypothesis_id
  const subClaims: SvSubClaimRow[] = [];
  const evidence: SvEvidenceEventRow[] = [];
  const turns: SvAgentTurnRow[] = [];

  return {
    hypotheses,
    verdicts,
    subClaims,
    evidence,
    turns,

    // Prompt resolution — returns empty template so agents use empty system prompts
    async getPromptByKey(_key: string): Promise<PromptRow | null> {
      return null;
    },

    // Hypothesis CRUD
    async createHypothesis(h: Omit<SvHypothesisRow, 'created_at' | 'updated_at'>): Promise<void> {
      const now = new Date().toISOString();
      hypotheses.set(h.id, { ...h, created_at: now, updated_at: now } as SvHypothesisRow);
    },
    async getHypothesis(id: string): Promise<SvHypothesisRow | null> {
      return hypotheses.get(id) ?? null;
    },
    async updateHypothesisStatus(id: string, status: SvHypothesisStatus, _ts?: string): Promise<void> {
      const row = hypotheses.get(id);
      if (row) {
        hypotheses.set(id, { ...row, status, updated_at: new Date().toISOString() });
      }
    },

    // Sub-claims
    async createSubClaim(sc: Omit<SvSubClaimRow, 'created_at'>): Promise<void> {
      subClaims.push({ ...sc, created_at: new Date().toISOString() });
    },
    async listSubClaims(_hypothesisId: string): Promise<SvSubClaimRow[]> {
      return subClaims.filter((sc) => sc.hypothesis_id === _hypothesisId);
    },

    // Verdict
    async createVerdict(v: Omit<SvVerdictRow, 'created_at'>): Promise<void> {
      const row = { ...v, created_at: new Date().toISOString() };
      verdicts.set(v.id, row);
      verdictsByHypothesis.set(v.hypothesis_id, row);
    },
    async getVerdictByHypothesis(hypothesisId: string): Promise<SvVerdictRow | null> {
      return verdictsByHypothesis.get(hypothesisId) ?? null;
    },
    async getVerdictById(id: string): Promise<SvVerdictRow | null> {
      return verdicts.get(id) ?? null;
    },

    // Evidence events
    async createEvidenceEvent(e: Omit<SvEvidenceEventRow, 'created_at'>): Promise<void> {
      evidence.push({ ...e, created_at: new Date().toISOString() });
    },
    async listEvidenceEvents(_hypothesisId: string): Promise<SvEvidenceEventRow[]> {
      return evidence.filter((ev) => ev.hypothesis_id === _hypothesisId);
    },

    // Agent turns
    async createAgentTurn(t: Omit<SvAgentTurnRow, 'created_at'>): Promise<void> {
      turns.push({ ...t, created_at: new Date().toISOString() });
    },
    async listAgentTurns(_hypothesisId: string): Promise<SvAgentTurnRow[]> {
      return turns.filter((at) => at.hypothesis_id === _hypothesisId);
    },

    // Budget envelope (not used in workflow but may be called)
    async getBudgetEnvelope(_id: string): Promise<SvBudgetEnvelopeRow | null> {
      return null;
    },
    async createBudgetEnvelope(b: Omit<SvBudgetEnvelopeRow, 'created_at' | 'updated_at'>): Promise<void> {
      void b;
    },
  };
}

// ── Canned model responses per step ─────────────────────────────────────────

/** Decomposer response — always valid JSON with one sub-claim. */
const DECOMPOSER_JSON = JSON.stringify({
  subClaims: [
    {
      statement: 'Regular aerobic exercise increases VO2max and reduces LDL cholesterol.',
      claimType: 'mechanism',
      testabilityScore: 0.9,
      rationale: 'Measurable via randomised controlled trials.',
    },
  ],
});

/** Supervisor response for a 'supported' verdict (known-true hypothesis). */
const SUPERVISOR_SUPPORTED = JSON.stringify({
  verdict: 'SUPPORTED',
  confidence: 0.85,
  summary: 'Overwhelming RCT evidence supports the claim. Effect size is consistent across populations.',
});

/** Supervisor response for a 'refuted' verdict (known-false hypothesis). */
const SUPERVISOR_REFUTED = JSON.stringify({
  verdict: 'CONTRADICTED',
  confidence: 0.92,
  summary: 'No plausible physical mechanism. Meta-analyses show only placebo effects.',
});

/** Supervisor response for an 'inconclusive' verdict (ill-posed hypothesis). */
const SUPERVISOR_INCONCLUSIVE = JSON.stringify({
  verdict: 'INSUFFICIENT_EVIDENCE',
  confidence: 0.55,
  summary: 'Hypothesis is not operationalised. No agreed measurement protocol exists.',
});

/** Generic literature/stats/math/sim/adversarial agent text responses. */
const GENERIC_AGENT_TEXT = 'Evidence review complete. See summary above.';

// ── Test harness helpers ─────────────────────────────────────────────────────

process.env['FAKE_CONTAINER_RUNTIME'] = '1';

function buildToolMap(): Record<string, Tool> {
  try {
    return createSVToolMap();
  } catch {
    return {};
  }
}

function makeRunner(
  db: Partial<DatabaseAdapter>,
  supervisorText: string,
): SVWorkflowRunner {
  // Each model is called for multiple agents; the cycled responses ensure
  // the correct JSON is returned when the supervisor agent fires last.
  const reasoningModel = weaveFakeModel({
    responses: [
      DECOMPOSER_JSON,          // call 1 → decomposer
      GENERIC_AGENT_TEXT,       // call 2 → adversarial
      supervisorText,            // call 3 → supervisor
    ],
  });

  const toolModel = weaveFakeModel({
    responses: [
      GENERIC_AGENT_TEXT,       // call 1 → literature
      GENERIC_AGENT_TEXT,       // call 2 → statistical
      GENERIC_AGENT_TEXT,       // call 3 → mathematical
      GENERIC_AGENT_TEXT,       // call 4 → simulation
    ],
  });

  return new SVWorkflowRunner({
    db: db as DatabaseAdapter,
    makeReasoningModel: async () => reasoningModel,
    makeToolModel: async () => toolModel,
    toolMap: buildToolMap(),
  });
}

type FakeDb = ReturnType<typeof createFakeDb>;

function insertHypothesis(db: FakeDb, id: string, statement: string): void {
  const now = new Date().toISOString();
  db.hypotheses.set(id, {
    id,
    tenant_id: 'tenant-test',
    submitted_by: 'user-test',
    title: 'Integration test hypothesis',
    statement,
    domain_tags: '[]',
    status: 'queued',
    budget_envelope_id: 'budget-test',
    workflow_run_id: null,
    trace_id: 'trace-test',
    contract_id: 'contract-test',
    created_at: now,
    updated_at: now,
  });
}

afterEach(() => {
  resetSVRunner();
});

// ── Canned hypothesis test cases ─────────────────────────────────────────────

describe('SV workflow — canned hypothesis: known-true (aerobic exercise)', () => {
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb();
    insertHypothesis(
      db,
      'hyp-known-true-001',
      'Regular aerobic exercise (≥150 min/week) significantly improves cardiovascular health markers in adults aged 18–65.',
    );
  });

  it('completes the full workflow pipeline and emits a supported verdict', async () => {
    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);
    await runner.startRun({
      hypothesisId: 'hyp-known-true-001',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Regular aerobic exercise improves cardiovascular health.',
      domainTags: ['cardiology', 'exercise-science'],
      budgetId: 'budget-test',
    });

    // Hypothesis status should be 'verdict' after completion
    const hyp = db.hypotheses.get('hyp-known-true-001');
    expect(hyp?.status).toBe('verdict');

    // A verdict row must be written
    const verdict = await db.getVerdictByHypothesis!('hyp-known-true-001');
    expect(verdict).not.toBeNull();
    expect(verdict?.verdict).toBe('supported');
    expect(verdict?.confidence_lo).toBeGreaterThan(0);
    expect(verdict?.confidence_hi).toBeLessThanOrEqual(1);
  });

  it('persists at least one sub-claim after decomposition', async () => {
    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);
    await runner.startRun({
      hypothesisId: 'hyp-known-true-001',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Regular aerobic exercise improves cardiovascular health.',
      domainTags: [],
      budgetId: 'budget-test',
    });

    const sc = await (db as DatabaseAdapter).listSubClaims('hyp-known-true-001');
    expect(sc.length).toBeGreaterThanOrEqual(1);
    expect(sc[0]?.statement).toBeTruthy();
    expect(sc[0]?.claim_type).toBe('mechanism');
  });

  it('persists at least one agent turn during deliberation', async () => {
    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);
    await runner.startRun({
      hypothesisId: 'hyp-known-true-001',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Regular aerobic exercise improves cardiovascular health.',
      domainTags: [],
      budgetId: 'budget-test',
    });

    const turns = await (db as DatabaseAdapter).listAgentTurns('hyp-known-true-001');
    expect(turns.length).toBeGreaterThan(0);
    // Should include an adversarial turn (dissent)
    const dissenting = turns.filter((t) => t.dissent === 1);
    expect(dissenting.length).toBeGreaterThan(0);
  });
});

describe('SV workflow — canned hypothesis: known-false (homeopathy)', () => {
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb();
    insertHypothesis(
      db,
      'hyp-known-false-001',
      'Homeopathic dilutions retain a "memory" of the original substance and produce measurable physiological effects beyond placebo.',
    );
  });

  it('emits a refuted verdict for a known-false hypothesis', async () => {
    const runner = makeRunner(db, SUPERVISOR_REFUTED);
    await runner.startRun({
      hypothesisId: 'hyp-known-false-001',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Homeopathic dilutions produce measurable physiological effects beyond placebo.',
      domainTags: ['pharmacology', 'alternative-medicine'],
      budgetId: 'budget-test',
    });

    const verdict = await db.getVerdictByHypothesis!('hyp-known-false-001');
    expect(verdict).not.toBeNull();
    expect(verdict?.verdict).toBe('refuted');
  });

  it('marks hypothesis status as "verdict" after completion', async () => {
    const runner = makeRunner(db, SUPERVISOR_REFUTED);
    await runner.startRun({
      hypothesisId: 'hyp-known-false-001',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Homeopathic dilutions produce measurable physiological effects beyond placebo.',
      domainTags: [],
      budgetId: 'budget-test',
    });

    const hyp = db.hypotheses.get('hyp-known-false-001');
    expect(hyp?.status).toBe('verdict');
  });
});

describe('SV workflow — canned hypothesis: ill-posed (consciousness)', () => {
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb();
    insertHypothesis(
      db,
      'hyp-ill-posed-001',
      'Consciousness is a fundamental, irreducible property of the universe present in all matter.',
    );
  });

  it('emits an inconclusive verdict for an ill-posed hypothesis', async () => {
    const runner = makeRunner(db, SUPERVISOR_INCONCLUSIVE);
    await runner.startRun({
      hypothesisId: 'hyp-ill-posed-001',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Consciousness is a fundamental property of the universe.',
      domainTags: ['philosophy-of-mind', 'neuroscience'],
      budgetId: 'budget-test',
    });

    const verdict = await db.getVerdictByHypothesis!('hyp-ill-posed-001');
    expect(verdict).not.toBeNull();
    expect(verdict?.verdict).toBe('inconclusive');
  });

  it('confidence interval is within [0, 1]', async () => {
    const runner = makeRunner(db, SUPERVISOR_INCONCLUSIVE);
    await runner.startRun({
      hypothesisId: 'hyp-ill-posed-001',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Consciousness is a fundamental property of the universe.',
      domainTags: [],
      budgetId: 'budget-test',
    });

    const verdict = await db.getVerdictByHypothesis!('hyp-ill-posed-001');
    expect(verdict?.confidence_lo).toBeGreaterThanOrEqual(0);
    expect(verdict?.confidence_hi).toBeLessThanOrEqual(1);
    expect(verdict?.confidence_hi).toBeGreaterThanOrEqual(verdict?.confidence_lo ?? 0);
  });
});

// ── Compensation tests ────────────────────────────────────────────────────────

describe('SV workflow — compensation / cancellation', () => {
  it('cancelRun immediately marks hypothesis as abandoned', async () => {
    const db = createFakeDb();
    insertHypothesis(db, 'hyp-cancel-001', 'Some hypothesis to be cancelled.');

    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);
    await runner.cancelRun('hyp-cancel-001');

    const hyp = db.hypotheses.get('hyp-cancel-001');
    expect(hyp?.status).toBe('abandoned');
  });

  it('cancelRun called before startRun still marks hypothesis as abandoned', async () => {
    const db = createFakeDb();
    insertHypothesis(db, 'hyp-cancel-002', 'Cancelled before run starts.');

    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);

    // Cancel before starting any run
    await runner.cancelRun('hyp-cancel-002');
    const hyp = db.hypotheses.get('hyp-cancel-002');
    expect(hyp?.status).toBe('abandoned');
  });

  it('does not write a verdict row when run is cancelled before completion', async () => {
    const db = createFakeDb();
    insertHypothesis(db, 'hyp-cancel-003', 'Test cancellation prevents verdict write.');

    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);
    await runner.cancelRun('hyp-cancel-003');

    const verdict = await db.getVerdictByHypothesis!('hyp-cancel-003');
    // No run was started, so no verdict should exist
    expect(verdict).toBeNull();
  });

  it('calling cancelRun twice is idempotent', async () => {
    const db = createFakeDb();
    insertHypothesis(db, 'hyp-cancel-004', 'Double cancel idempotency test.');

    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);
    await runner.cancelRun('hyp-cancel-004');
    await runner.cancelRun('hyp-cancel-004'); // second call — should not throw

    const hyp = db.hypotheses.get('hyp-cancel-004');
    expect(hyp?.status).toBe('abandoned');
  });
});

// ── Contract integrity tests ─────────────────────────────────────────────────

describe('SV workflow — contract integrity', () => {
  it('every completed run emits a verdict with a non-empty contract_id and replay_trace_id', async () => {
    const db = createFakeDb();
    insertHypothesis(db, 'hyp-contract-001', 'Vitamin D supplementation reduces depression symptoms.');

    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);
    await runner.startRun({
      hypothesisId: 'hyp-contract-001',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Vitamin D supplementation reduces depression symptoms.',
      domainTags: ['psychiatry'],
      budgetId: 'budget-test',
    });

    const verdict = await db.getVerdictByHypothesis!('hyp-contract-001');
    expect(verdict?.contract_id).toBeTruthy();
    expect(verdict?.replay_trace_id).toBeTruthy();
    // UUIDs should not be empty strings
    expect(verdict?.contract_id.length).toBeGreaterThan(8);
    expect(verdict?.replay_trace_id.length).toBeGreaterThan(8);
  });

  it('every completed run has emitted_by = "supervisor"', async () => {
    const db = createFakeDb();
    insertHypothesis(db, 'hyp-contract-002', 'Green tea polyphenols inhibit cancer cell proliferation.');

    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);
    await runner.startRun({
      hypothesisId: 'hyp-contract-002',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Green tea polyphenols inhibit cancer cell proliferation.',
      domainTags: ['oncology'],
      budgetId: 'budget-test',
    });

    const verdict = await db.getVerdictByHypothesis!('hyp-contract-002');
    expect(verdict?.emitted_by).toBe('supervisor');
  });

  it('verdict id uses UUID format (36 chars with dashes)', async () => {
    const db = createFakeDb();
    insertHypothesis(db, 'hyp-contract-003', 'Sleep deprivation increases cortisol levels.');

    const runner = makeRunner(db, SUPERVISOR_SUPPORTED);
    await runner.startRun({
      hypothesisId: 'hyp-contract-003',
      tenantId: 'tenant-test',
      userId: 'user-test',
      statement: 'Sleep deprivation increases cortisol levels.',
      domainTags: ['endocrinology'],
      budgetId: 'budget-test',
    });

    const verdict = await db.getVerdictByHypothesis!('hyp-contract-003');
    expect(verdict?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
