/**
 * @weaveintel/workflows — Phase 4 contract emitter unit tests.
 *
 * Covers `buildContractBody` (with/without bodyMap, `$` literal, missing
 * source paths) and `buildEmittedContract` (null when no `outputContract`,
 * evidence inclusion, meshId/metadata propagation).
 */
import { describe, it, expect } from 'vitest';
import {
  buildContractBody,
  buildEmittedContract,
  type EmittedContract,
} from './index.js';
import type { WorkflowDefinition, WorkflowRun, WorkflowOutputContract } from '@weaveintel/core';

const baseDef = (oc?: WorkflowOutputContract): WorkflowDefinition => ({
  id: 'wf-1',
  name: 'demo',
  version: '1.0.0',
  steps: [
    { id: 's1', name: 's1', type: 'deterministic' },
  ],
  entryStepId: 's1',
  ...(oc !== undefined ? { outputContract: oc } : {}),
});

const baseRun = (vars: Record<string, unknown>): WorkflowRun => ({
  id: 'run-1',
  workflowId: 'wf-1',
  status: 'completed',
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  state: {
    currentStepId: 's1',
    variables: vars,
    history: [
      {
        stepId: 's1',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'completed',
        output: { ok: true },
      },
    ],
  },
});

describe('buildContractBody', () => {
  it('returns shallow copy of variables when bodyMap is omitted', () => {
    const oc: WorkflowOutputContract = { kind: 'demo.completed' };
    const body = buildContractBody(oc, { a: 1, b: 'x' });
    expect(body).toEqual({ a: 1, b: 'x' });
  });

  it('projects via bodyMap with dotted destination paths', () => {
    const oc: WorkflowOutputContract = {
      kind: 'demo.completed',
      bodyMap: { 'result.value': 'inner.x', 'count': 'n' },
    };
    const body = buildContractBody(oc, { inner: { x: 42 }, n: 7 });
    expect(body).toEqual({ result: { value: 42 }, count: 7 });
  });

  it('treats "$" srcPath as the entire variables object', () => {
    const oc: WorkflowOutputContract = {
      kind: 'demo.completed',
      bodyMap: { all: '$' },
    };
    const body = buildContractBody(oc, { a: 1, b: 2 });
    expect(body).toEqual({ all: { a: 1, b: 2 } });
  });

  it('writes undefined when source path is missing', () => {
    const oc: WorkflowOutputContract = {
      kind: 'demo.completed',
      bodyMap: { missing: 'never.set' },
    };
    const body = buildContractBody(oc, { other: 1 });
    expect(body).toHaveProperty('missing');
    expect((body as { missing: unknown }).missing).toBeUndefined();
  });
});

describe('buildEmittedContract', () => {
  it('returns null when definition has no outputContract', () => {
    const result = buildEmittedContract(baseDef(), baseRun({ a: 1 }));
    expect(result).toBeNull();
  });

  it('builds an EmittedContract with kind and body and meta', () => {
    const oc: WorkflowOutputContract = { kind: 'demo.completed' };
    const def = baseDef(oc);
    const run = baseRun({ result: 'ok' });
    const result = buildEmittedContract(def, run) as EmittedContract;
    expect(result).not.toBeNull();
    expect(result.kind).toBe('demo.completed');
    expect(result.body).toEqual({ result: 'ok' });
    expect(result.meta.workflowDefinitionId).toBe('wf-1');
    expect(result.meta.workflowRunId).toBe('run-1');
    expect(typeof result.meta.emittedAt).toBe('string');
    expect(result.evidence).toBeUndefined();
  });

  it('includes evidence (run history) when fromHistory is true', () => {
    const oc: WorkflowOutputContract = {
      kind: 'demo.completed',
      evidence: { fromHistory: true },
    };
    const result = buildEmittedContract(baseDef(oc), baseRun({ x: 1 })) as EmittedContract;
    expect(result.evidence).toBeDefined();
    expect(Array.isArray(result.evidence)).toBe(true);
    expect((result.evidence as unknown[]).length).toBe(1);
  });

  it('propagates meshId and metadata from outputContract', () => {
    const oc: WorkflowOutputContract = {
      kind: 'demo.completed',
      meshId: 'mesh-abc',
      metadata: { source: 'phase4-test' },
    };
    const result = buildEmittedContract(baseDef(oc), baseRun({})) as EmittedContract;
    expect(result.meta.meshId).toBe('mesh-abc');
    expect(result.meta.metadata).toEqual({ source: 'phase4-test' });
  });
});
