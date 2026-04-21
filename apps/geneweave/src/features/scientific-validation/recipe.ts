/**
 * Scientific Validation — Recipe Registration
 *
 * Registers the `scientific-validation` workflow as a DB-backed recipe config
 * in the `recipe_configs` table so operators can see, enable/disable, and
 * configure it via the admin UI without a code deploy.
 *
 * `seedSVRecipe(db)` is called from `index.ts` at feature registration time.
 * It is idempotent — if the row already exists the insert is skipped.
 */

import type { DatabaseAdapter } from '../../db.js';
import type { RecipeConfigRow } from '../../db-types.js';

/** Stable UUID for the SV recipe config row. Never changes across deploys. */
export const SV_RECIPE_ID = 'f1e2d3c4-b5a6-7890-a1b2-c3d4e5f60001';

/**
 * The recipe config record for the scientific-validation feature.
 *
 * `options` carries feature-specific metadata:
 *  - `workflowId`  — the workflow definition id used by SVWorkflowRunner
 *  - `agents`      — the seven specialist agents in execution order
 *  - `maxRounds`   — deliberation cap before forced convergence
 *  - `epsilonConfidenceThreshold` — minimum confidence margin to declare convergence
 */
export const SV_RECIPE_CONFIG: Omit<RecipeConfigRow, 'created_at' | 'updated_at'> = {
  id: SV_RECIPE_ID,
  name: 'Scientific Validation',
  description:
    'Multi-agent hypothesis validation pipeline. ' +
    'Decomposes a scientific claim into sub-claims, gathers literature evidence, ' +
    'runs statistical / mathematical / simulation analysis in parallel, ' +
    'applies adversarial falsification, and emits a structured evidence-backed verdict.',
  recipe_type: 'scientific-validation',
  model: null,         // model selection is delegated to @weaveintel/routing per agent role
  provider: null,
  system_prompt: null, // system prompts loaded from DB via sv-seed.ts keys
  tools: JSON.stringify([
    'arxiv.search', 'pubmed.search', 'semanticscholar.search',
    'openalex.search', 'crossref.resolve', 'europepmc.search',
    'scipy.stats.test', 'statsmodels.meta', 'scipy.power',
    'pymc.mcmc', 'r.metafor', 'sympy.simplify', 'sympy.solve',
    'sympy.integrate', 'wolfram.query', 'rdkit.descriptors',
    'biopython.align', 'networkx.analyse',
  ]),
  guardrails: JSON.stringify([]),
  max_steps: 7,
  options: JSON.stringify({
    workflowId: 'sv-workflow-v1',
    agents: [
      'decomposer', 'literature', 'statistical',
      'mathematical', 'simulation', 'adversarial', 'supervisor',
    ],
    maxRounds: 3,
    epsilonConfidenceThreshold: 0.15,
    budgetEnvelope: {
      maxTokens: 500_000,
      maxCostUsd: 5.0,
      maxWallMs: 900_000,
    },
  }),
  enabled: 1,
};

/**
 * Idempotently seeds the SV recipe config row.
 * Called once at feature registration time (from index.ts).
 */
export async function seedSVRecipe(db: DatabaseAdapter): Promise<void> {
  try {
    const existing = await db.getRecipeConfig(SV_RECIPE_ID);
    if (!existing) {
      await db.createRecipeConfig(SV_RECIPE_CONFIG);
    }
  } catch {
    // Non-fatal — the recipe row missing does not block workflow execution.
    // The operator can create it manually via the admin UI if needed.
  }
}
