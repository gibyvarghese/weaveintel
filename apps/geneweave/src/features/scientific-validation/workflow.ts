/**
 * Scientific Validation Workflow Definition
 *
 * Stages:
 *   decompose → gather → analyse (fanout: statistical + mathematical + simulation)
 *               → falsify → deliberate (dialogue loop) → verdict
 *
 * The workflow is registered at startup and referenced by the route handlers
 * when a new hypothesis validation run is started.
 */

import { defineWorkflow } from '@weaveintel/workflows';

export const scientificValidationWorkflow = defineWorkflow('scientific-validation')
  .setId('sv-workflow-v1')
  .setVersion('1.0.0')
  .setDescription(
    'End-to-end scientific hypothesis validation: decompose claims, gather literature, ' +
    'run statistical/mathematical/simulation analysis, adversarial falsification, ' +
    'and emit a structured evidence-backed verdict.',
  )
  // Step 1 — decompose the hypothesis into testable sub-claims
  .agentic('decompose', 'Decompose hypothesis', {
    handler: 'decomposer',
    next: 'gather',
  })
  // Step 2 — literature retrieval (sequential, feeds all analysis agents)
  .agentic('gather', 'Gather literature evidence', {
    handler: 'literature',
    next: 'analyse',
    timeout: 120_000,
  })
  // Step 3 — parallel analysis fan-out
  .branch('analyse', 'Analyse evidence (parallel)', {
    handler: 'analyse-fanout',
    branches: ['statistical', 'mathematical', 'simulation'],
  })
  // Step 3a — statistical analysis
  .agentic('statistical', 'Statistical analysis', {
    handler: 'statistical',
    next: 'falsify',
    timeout: 180_000,
  })
  // Step 3b — mathematical verification
  .agentic('mathematical', 'Mathematical verification', {
    handler: 'mathematical',
    next: 'falsify',
    timeout: 120_000,
  })
  // Step 3c — computational simulation
  .agentic('simulation', 'Computational simulation', {
    handler: 'simulation',
    next: 'falsify',
    timeout: 300_000,
  })
  // Step 4 — adversarial falsification (all analysis results in context)
  .agentic('falsify', 'Adversarial falsification', {
    handler: 'adversarial',
    next: 'deliberate',
    timeout: 120_000,
  })
  // Step 5 — deliberation dialogue loop (convergence check)
  .agentic('deliberate', 'Deliberation loop', {
    handler: 'deliberate',
    next: 'verdict',
    timeout: 600_000,
    config: {
      // Convergence rule: top verdict must have confidence margin > 0.15
      epsilonConfidenceThreshold: 0.15,
      // How many deliberation rounds before forced convergence
      maxRounds: 3,
    },
  })
  // Step 6 — emit final verdict
  .agentic('verdict', 'Emit verdict', {
    handler: 'supervisor',
    timeout: 60_000,
  })
  .build();
