/**
 * Scientific Validation Workflow Runner
 *
 * A singleton that:
 *  1. Registers the SV workflow definition with a DefaultWorkflowEngine
 *  2. Provides async step handlers that delegate to the specialist agents
 *  3. Persists evidence events and agent turns to the DB for SSE streaming
 *  4. Exposes `startRun()` and `cancelRun()` for route handlers
 *
 * The runner is constructed with a model factory so that agents can be
 * created per-run without leaking state between runs.
 *
 * System prompts are loaded from the `prompts` DB table on construction
 * (via keys from SV_PROMPT_KEY). Operators may edit them at runtime via
 * the admin UI without a code deploy.
 */

import { createWorkflowEngine } from '@weaveintel/workflows';
import type { SvClaimType } from '../../db-types.js';
import { weaveToolRegistry, weaveContext } from '@weaveintel/core';
import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../../db.js';
import type { Tool, ExecutionContext, Model } from '@weaveintel/core';
import { scientificValidationWorkflow } from './workflow.js';
import { SV_PROMPT_KEY } from './sv-seed.js';
import {
  createDecomposerAgent,
  createLiteratureAgent,
  createStatisticalAgent,
  createMathematicalAgent,
  createSimulationAgent,
  createAdversarialAgent,
  createSupervisorAgent,
} from './agents/index.js';

export interface SVRunnerOptions {
  db: DatabaseAdapter;
  /** Factory that creates a reasoning model (for decomposer, adversarial, supervisor). */
  makeReasoningModel: () => Promise<Model>;
  /** Factory that creates a tool-calling model (for literature, statistical, etc.). */
  makeToolModel: () => Promise<Model>;
  /** Full SV tool map from createSVToolMap(). */
  toolMap: Record<string, Tool>;
}

export interface SVRunInput {
  hypothesisId: string;
  tenantId: string;
  userId: string;
  statement: string;
  domainTags: string[];
  budgetId: string;
}

/** Helper: build a ToolRegistry from a subset of keys in the tool map. */
function registryFromKeys(toolMap: Record<string, Tool>, keys: string[]) {
  const registry = weaveToolRegistry();
  for (const k of keys) {
    const t = toolMap[k];
    if (t) registry.register(t);
  }
  return registry;
}

/** Append an agent turn row and return immediately (best-effort). */
async function appendTurn(
  db: DatabaseAdapter,
  hypothesisId: string,
  roundIndex: number,
  fromAgent: string,
  message: string,
  opts?: { toAgent?: string; dissent?: boolean; citesEvidenceIds?: string[] },
): Promise<void> {
  try {
    await db.createAgentTurn({
      id: randomUUID(),
      hypothesis_id: hypothesisId,
      round_index: roundIndex,
      from_agent: fromAgent,
      to_agent: opts?.toAgent ?? null,
      message,
      cites_evidence_ids: JSON.stringify(opts?.citesEvidenceIds ?? []),
      dissent: opts?.dissent ? 1 : 0,
    });
  } catch {
    // non-fatal — SSE clients will see a gap but won't crash the run
  }
}

/** Append an evidence event row (best-effort). */
async function appendEvidence(
  db: DatabaseAdapter,
  hypothesisId: string,
  stepId: string,
  agentId: string,
  kind: string,
  summary: string,
  opts?: { toolKey?: string; reproducibilityHash?: string; evidenceId?: string },
): Promise<string> {
  const evidenceId = opts?.evidenceId ?? randomUUID();
  try {
    await db.createEvidenceEvent({
      id: randomUUID(),
      hypothesis_id: hypothesisId,
      step_id: stepId,
      agent_id: agentId,
      evidence_id: evidenceId,
      kind,
      summary,
      source_type: opts?.toolKey ? 'sandbox_tool_run' : 'model_inference',
      tool_key: opts?.toolKey ?? null,
      reproducibility_hash: opts?.reproducibilityHash ?? null,
    });
  } catch {
    // non-fatal
  }
  return evidenceId;
}

export class SVWorkflowRunner {
  private engine = createWorkflowEngine();
  private toolMap: Record<string, Tool>;
  private makeReasoningModel: () => Promise<Model>;
  private makeToolModel: () => Promise<Model>;
  private db: DatabaseAdapter;
  /** System prompts loaded from DB at construction, keyed by agent name. */
  private prompts: Record<string, string> = {};
  /** Map of hypothesisId → workflowRunId for cancellation. */
  private runIndex = new Map<string, string>();

  constructor(opts: SVRunnerOptions) {
    this.db = opts.db;
    this.toolMap = opts.toolMap;
    this.makeReasoningModel = opts.makeReasoningModel;
    this.makeToolModel = opts.makeToolModel;

    this.engine.createDefinition(scientificValidationWorkflow).catch(() => {
      // best-effort — definition might already be registered
    });

    // Load prompts async; handlers fall back to empty string if not yet loaded.
    this._loadPrompts().catch(() => {});
    this._registerHandlers();
  }

  /** Load all 7 SV system prompts from the DB into memory. Non-fatal. */
  private async _loadPrompts(): Promise<void> {
    for (const [agentName, promptKey] of Object.entries(SV_PROMPT_KEY)) {
      try {
        const row = await this.db.getPromptByKey(promptKey);
        if (row?.template) this.prompts[agentName] = row.template;
      } catch {
        // best-effort — agent will use empty string if DB is unavailable
      }
    }
  }

  private _registerHandlers(): void {
    const {
      db,
      toolMap,
      prompts,
      makeReasoningModel: mkReasoning,
      makeToolModel: mkTool,
    } = this;

    /** Create a per-run execution context from the variables dict. */
    function makeCtx(vars: Record<string, unknown>): ExecutionContext {
      return weaveContext({
        tenantId: vars['tenantId'] as string | undefined,
        userId: vars['userId'] as string | undefined,
      });
    }

    /** Extract the SVRunInput fields from workflow variables. */
    function getInput(vars: Record<string, unknown>): SVRunInput {
      return {
        hypothesisId: vars['hypothesisId'] as string,
        tenantId: vars['tenantId'] as string,
        userId: vars['userId'] as string,
        statement: vars['statement'] as string,
        domainTags: (vars['domainTags'] as string[] | undefined) ?? [],
        budgetId: vars['budgetId'] as string,
      };
    }

    // ── decomposer ──────────────────────────────────────────
    this.engine.registerHandler('decomposer', async (vars) => {
      const input = getInput(vars);
      const ctx = makeCtx(vars);
      const agent = createDecomposerAgent({ model: await mkReasoning(), systemPrompt: prompts['decomposer'] ?? '' });
      const result = await agent.run(ctx, {
        messages: [{ role: 'user', content: `Hypothesis: ${input.statement}\nDomain tags: ${input.domainTags.join(', ')}` }],
      });
      const text = result.output ?? '';
      await appendTurn(db, input.hypothesisId, 0, 'decomposer', text);
      // Persist sub-claims extracted from the JSON output
      try {
        const parsed = JSON.parse(text) as { subClaims?: Array<{ statement: string; claimType: string; testabilityScore: number; rationale: string }> };
        const subClaims = parsed.subClaims ?? [];
        for (const sc of subClaims) {
          await db.createSubClaim({
            id: randomUUID(),
            tenant_id: input.tenantId,
            hypothesis_id: input.hypothesisId,
            parent_sub_claim_id: null,
            claim_type: (sc.claimType ?? 'other') as SvClaimType,
            statement: sc.statement,
            testability_score: sc.testabilityScore ?? 0.5,
          });
        }
      } catch {
        // non-fatal — sub-claims will be empty if model returned invalid JSON
      }
      return { decomposedText: text };
    });

    // ── literature ──────────────────────────────────────────
    this.engine.registerHandler('literature', async (vars) => {
      const input = getInput(vars);
      const ctx = makeCtx(vars);
      const reg = registryFromKeys(toolMap, [
        'arxiv.search', 'pubmed.search', 'semanticscholar.search',
        'openalex.search', 'crossref.resolve', 'europepmc.search',
      ]);
      const agent = createLiteratureAgent({ model: await mkTool(), tools: reg, systemPrompt: prompts['literature'] ?? '' });
      const decomposedText = ((vars['__step_decompose'] as { decomposedText?: string } | undefined)?.decomposedText) ?? '';
      const result = await agent.run(ctx, {
        messages: [{ role: 'user', content: `Sub-claims:\n${decomposedText}\n\nHypothesis: ${input.statement}` }],
      });
      const text = result.output ?? '';
      await appendTurn(db, input.hypothesisId, 0, 'literature', text);
      // Emit evidence events for each paper found
      try {
        const jsonStart = text.lastIndexOf('{');
        if (jsonStart >= 0) {
          const parsed = JSON.parse(text.slice(jsonStart)) as { evidence?: Array<{ id: string; title: string; summary: string; toolKey?: string }> };
          for (const ev of (parsed.evidence ?? [])) {
            await appendEvidence(db, input.hypothesisId, 'gather', 'literature', 'lit_hit', ev.summary, {
              toolKey: ev.toolKey,
              evidenceId: randomUUID(),
            });
          }
        }
      } catch {
        // non-fatal
      }
      return { literatureText: text };
    });

    // ── statistical ─────────────────────────────────────────
    this.engine.registerHandler('statistical', async (vars) => {
      const input = getInput(vars);
      const ctx = makeCtx(vars);
      const reg = registryFromKeys(toolMap, [
        'scipy.stats.test', 'statsmodels.meta', 'scipy.power', 'pymc.mcmc', 'r.metafor',
      ]);
      const agent = createStatisticalAgent({ model: await mkTool(), tools: reg, systemPrompt: prompts['statistical'] ?? '' });
      const literatureText = ((vars['__step_gather'] as { literatureText?: string } | undefined)?.literatureText) ?? '';
      const result = await agent.run(ctx, {
        messages: [{ role: 'user', content: `Literature evidence:\n${literatureText}` }],
      });
      const text = result.output ?? '';
      await appendTurn(db, input.hypothesisId, 0, 'statistical', text);
      await appendEvidence(db, input.hypothesisId, 'statistical', 'statistical', 'stat_finding', text.slice(0, 200));
      return { statisticalText: text };
    });

    // ── mathematical ────────────────────────────────────────
    this.engine.registerHandler('mathematical', async (vars) => {
      const input = getInput(vars);
      const ctx = makeCtx(vars);
      const reg = registryFromKeys(toolMap, [
        'sympy.simplify', 'sympy.solve', 'sympy.integrate', 'wolfram.query',
      ]);
      const agent = createMathematicalAgent({ model: await mkTool(), tools: reg, systemPrompt: prompts['mathematical'] ?? '' });
      const decomposedText = ((vars['__step_decompose'] as { decomposedText?: string } | undefined)?.decomposedText) ?? '';
      const result = await agent.run(ctx, {
        messages: [{ role: 'user', content: `Sub-claims:\n${decomposedText}` }],
      });
      const text = result.output ?? '';
      await appendTurn(db, input.hypothesisId, 0, 'mathematical', text);
      await appendEvidence(db, input.hypothesisId, 'mathematical', 'mathematical', 'math_result', text.slice(0, 200));
      return { mathematicalText: text };
    });

    // ── simulation ──────────────────────────────────────────
    this.engine.registerHandler('simulation', async (vars) => {
      const input = getInput(vars);
      const ctx = makeCtx(vars);
      const reg = registryFromKeys(toolMap, [
        'scipy.power', 'pymc.mcmc', 'rdkit.descriptors', 'biopython.align', 'networkx.analyse',
      ]);
      const agent = createSimulationAgent({ model: await mkTool(), tools: reg, systemPrompt: prompts['simulation'] ?? '' });
      const literatureText = ((vars['__step_gather'] as { literatureText?: string } | undefined)?.literatureText) ?? '';
      const result = await agent.run(ctx, {
        messages: [{ role: 'user', content: `Literature evidence:\n${literatureText}\n\nHypothesis: ${input.statement}` }],
      });
      const text = result.output ?? '';
      await appendTurn(db, input.hypothesisId, 0, 'simulation', text);
      await appendEvidence(db, input.hypothesisId, 'simulation', 'simulation', 'sim_result', text.slice(0, 200));
      return { simulationText: text };
    });

    // ── adversarial ─────────────────────────────────────────
    this.engine.registerHandler('adversarial', async (vars) => {
      const input = getInput(vars);
      const ctx = makeCtx(vars);
      const reg = registryFromKeys(toolMap, [
        'arxiv.search', 'pubmed.search', 'semanticscholar.search',
        'openalex.search', 'europepmc.search',
        'scipy.stats.test', 'statsmodels.meta',
        'sympy.simplify', 'sympy.solve',
      ]);
      const agent = createAdversarialAgent({ model: await mkReasoning(), tools: reg, systemPrompt: prompts['adversarial'] ?? '' });
      const statText = ((vars['__step_statistical'] as { statisticalText?: string } | undefined)?.statisticalText) ?? '';
      const mathText = ((vars['__step_mathematical'] as { mathematicalText?: string } | undefined)?.mathematicalText) ?? '';
      const simText = ((vars['__step_simulation'] as { simulationText?: string } | undefined)?.simulationText) ?? '';
      const result = await agent.run(ctx, {
        messages: [{
          role: 'user',
          content: `Hypothesis: ${input.statement}\n\nStatistical analysis:\n${statText}\n\nMath analysis:\n${mathText}\n\nSimulation:\n${simText}`,
        }],
      });
      const text = result.output ?? '';
      await appendTurn(db, input.hypothesisId, 0, 'adversarial', text, { dissent: true });
      return { adversarialText: text };
    });

    // ── deliberate (dialogue loop) ──────────────────────────
    this.engine.registerHandler('deliberate', async (vars) => {
      const input = getInput(vars);
      const adversarialText = ((vars['__step_falsify'] as { adversarialText?: string } | undefined)?.adversarialText) ?? '';
      const statText = ((vars['__step_statistical'] as { statisticalText?: string } | undefined)?.statisticalText) ?? '';
      // Single-round deliberation: adversarial challenges, statistical responds
      await appendTurn(db, input.hypothesisId, 1, 'adversarial', adversarialText.slice(0, 500), {
        toAgent: 'statistical', dissent: true,
      });
      await appendTurn(db, input.hypothesisId, 1, 'statistical', `In response to adversarial challenge: ${statText.slice(0, 300)}`, {
        toAgent: 'adversarial', dissent: false,
      });
      return { deliberationText: adversarialText + '\n\n' + statText };
    });

    // ── supervisor ──────────────────────────────────────────
    this.engine.registerHandler('supervisor', async (vars) => {
      const input = getInput(vars);
      const ctx = makeCtx(vars);
      const allOutputs = [
        ((vars['__step_gather'] as { literatureText?: string } | undefined)?.literatureText) ?? '',
        ((vars['__step_statistical'] as { statisticalText?: string } | undefined)?.statisticalText) ?? '',
        ((vars['__step_mathematical'] as { mathematicalText?: string } | undefined)?.mathematicalText) ?? '',
        ((vars['__step_simulation'] as { simulationText?: string } | undefined)?.simulationText) ?? '',
        ((vars['__step_falsify'] as { adversarialText?: string } | undefined)?.adversarialText) ?? '',
        ((vars['__step_deliberate'] as { deliberationText?: string } | undefined)?.deliberationText) ?? '',
      ].join('\n\n---\n\n');

      const agent = createSupervisorAgent({ model: await mkReasoning(), systemPrompt: prompts['supervisor'] ?? '' });
      const result = await agent.run(ctx, {
        messages: [{
          role: 'user',
          content: `Hypothesis: ${input.statement}\n\nFull evidence package:\n${allOutputs}`,
        }],
      });
      const text = result.output ?? '';
      await appendTurn(db, input.hypothesisId, 2, 'supervisor', text);

      // Parse and persist the verdict
      try {
        const jsonStart = text.indexOf('{');
        const verdictJson = jsonStart >= 0
          ? JSON.parse(text.slice(jsonStart)) as { verdict?: string; confidence?: number; summary?: string }
          : {} as { verdict?: string; confidence?: number; summary?: string };
        if (verdictJson.verdict) {
          const verdictMap: Record<string, string> = {
            SUPPORTED: 'supported', PARTIALLY_SUPPORTED: 'supported',
            CONTRADICTED: 'refuted', INSUFFICIENT_EVIDENCE: 'inconclusive',
            REQUIRES_REPLICATION: 'inconclusive',
          };
          const lo = Math.max(0, (verdictJson.confidence ?? 0.5) - 0.1);
          const hi = Math.min(1, (verdictJson.confidence ?? 0.5) + 0.1);
          await db.createVerdict({
            id: randomUUID(),
            tenant_id: input.tenantId,
            hypothesis_id: input.hypothesisId,
            verdict: (verdictMap[verdictJson.verdict] ?? 'inconclusive') as 'supported' | 'refuted' | 'inconclusive' | 'ill_posed' | 'out_of_scope',
            confidence_lo: lo,
            confidence_hi: hi,
            key_evidence_ids: '[]',
            falsifiers: '[]',
            limitations: verdictJson.summary ?? '',
            contract_id: randomUUID(),
            replay_trace_id: randomUUID(),
            emitted_by: 'supervisor',
          });
          await db.updateHypothesisStatus(input.hypothesisId, 'verdict', new Date().toISOString());
        }
      } catch {
        await db.updateHypothesisStatus(input.hypothesisId, 'abandoned', new Date().toISOString()).catch(() => {});
      }
      return { supervisorText: text };
    });

    // ── analyse-fanout (branch coordinator) ─────────────────
    this.engine.registerHandler('analyse-fanout', async () => {
      return {};
    });
  }

  /** Start an async validation run. Returns the workflowRunId immediately. */
  async startRun(input: SVRunInput): Promise<string> {
    await this.db.updateHypothesisStatus(input.hypothesisId, 'running', new Date().toISOString());
    const run = await this.engine.startRun('sv-workflow-v1', input as unknown as Record<string, unknown>);
    this.runIndex.set(input.hypothesisId, run.id);
    // Update status on run completion (non-blocking)
    run; // already completed synchronously in the engine for now
    return run.id;
  }

  /** Cancel an in-progress run. */
  async cancelRun(hypothesisId: string): Promise<void> {
    await this.db.updateHypothesisStatus(hypothesisId, 'abandoned', new Date().toISOString());
    // Workflow engine does not have a cancel API but the hypothesis status is persisted
  }
}

let _instance: SVWorkflowRunner | null = null;

/** Get (or lazily create) the singleton SVWorkflowRunner. */
export function getSVRunner(opts?: SVRunnerOptions): SVWorkflowRunner {
  if (!_instance) {
    if (!opts) throw new Error('SVWorkflowRunner not initialised — call getSVRunner with options first');
    _instance = new SVWorkflowRunner(opts);
  }
  return _instance;
}

/** Reinitialise the singleton (used in tests). */
export function resetSVRunner(): void {
  _instance = null;
}
