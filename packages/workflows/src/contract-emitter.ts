/**
 * @weaveintel/workflows — contract-emitter.ts
 *
 * Phase 4 — Mesh ↔ workflow binding.
 *
 * `ContractEmitter` is the structural contract the engine uses to publish
 * a typed mesh contract on successful workflow completion. The package
 * does NOT define a contract storage shape — apps wire their own emitter
 * (typically a thin wrapper over a DB write + an in-process bus) so the
 * triggers package can subscribe via a `contract_emitted` source adapter.
 *
 * The emit contract is intentionally narrow:
 *   - `kind` and `body` come from the WorkflowDefinition.outputContract +
 *     bodyMap projection.
 *   - `evidence` is the run history when `evidence.fromHistory` is true,
 *     otherwise omitted.
 *   - `meta` carries provenance the emitter persists alongside the row.
 *
 * Failures inside the emitter MUST NOT throw past the engine — they are
 * swallowed and logged; the workflow run still completes.
 */
import type { WorkflowOutputContract, WorkflowRun, WorkflowDefinition, WorkflowStepResult } from '@weaveintel/core';
import { readPath, writePath } from './path.js';

export interface EmittedContractMeta {
  workflowDefinitionId: string;
  workflowRunId: string;
  meshId?: string;
  emittedAt: string;
  metadata?: Record<string, unknown>;
}

export interface EmittedContract {
  kind: string;
  body: Record<string, unknown>;
  evidence?: WorkflowStepResult[];
  meta: EmittedContractMeta;
}

export interface ContractEmitter {
  emit(contract: EmittedContract): Promise<void>;
}

/**
 * Build the contract body by projecting `state.variables` through
 * `outputContract.bodyMap`. When no map is set, the entire variables
 * object is used as the body.
 */
export function buildContractBody(
  outputContract: WorkflowOutputContract,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const map = outputContract.bodyMap;
  if (!map) return { ...variables };
  const out: Record<string, unknown> = {};
  for (const [destPath, srcPath] of Object.entries(map)) {
    const value = !srcPath || srcPath === '$' ? variables : readPath(variables, srcPath);
    writePath(out, destPath, value);
  }
  return out;
}

/**
 * Construct an `EmittedContract` from a completed run + its definition.
 * Returns `null` when the definition has no `outputContract`.
 */
export function buildEmittedContract(
  def: WorkflowDefinition,
  run: WorkflowRun,
): EmittedContract | null {
  const oc = def.outputContract;
  if (!oc) return null;
  const body = buildContractBody(oc, run.state.variables);
  const includeEvidence = oc.evidence?.fromHistory === true;
  const meta: EmittedContractMeta = {
    workflowDefinitionId: def.id,
    workflowRunId: run.id,
    emittedAt: new Date().toISOString(),
    ...(oc.meshId !== undefined ? { meshId: oc.meshId } : {}),
    ...(oc.metadata !== undefined ? { metadata: oc.metadata } : {}),
  };
  return {
    kind: oc.kind,
    body,
    ...(includeEvidence ? { evidence: run.state.history } : {}),
    meta,
  };
}
