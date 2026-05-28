/**
 * @weaveintel/workflows — linter.ts
 *
 * Phase W6 — Static analysis for workflow definitions.
 *
 * `lintWorkflow(def)` performs zero-cost (no I/O) checks and returns an
 * ordered list of `LintResult` findings. Callers decide what to do with
 * errors vs warnings (reject, log, surface in UI).
 *
 * Also exports `getWorkflowGraph(def)` which produces an adjacency list
 * suitable for rendering in a visual editor.
 */

import type { WorkflowDefinition, WorkflowStep, LintResult, WorkflowGraph, WorkflowGraphNode, WorkflowGraphEdge } from '@weaveintel/core';

// ─── Linter ────────────────────────────────────────────────────────────────

/**
 * Static-analyse a workflow definition and return all findings.
 *
 * Checks performed:
 *  1. Entry step exists in steps list
 *  2. All `next` references resolve to a known step ID
 *  3. Unreachable steps (not reachable via DFS from entryStepId)
 *  4. Circular references (cycle in the step graph)
 *  5. `condition` / `branch` steps — `next` length matches semantics
 *  6. `parallel` steps with no handlers
 *  7. Non-terminal steps missing `next` (warning)
 *  8. Steps with no handler for non-expression types (warning)
 */
export function lintWorkflow(def: WorkflowDefinition): LintResult[] {
  const results: LintResult[] = [];
  const stepMap = new Map<string, WorkflowStep>(def.steps.map(s => [s.id, s]));

  // — 1. Entry step exists
  if (!stepMap.has(def.entryStepId)) {
    results.push({
      severity: 'error',
      rule: 'missing-entry-step',
      message: `Entry step "${def.entryStepId}" is not defined in steps`,
    });
  }

  for (const step of def.steps) {
    const nexts = Array.isArray(step.next)
      ? (step.next as string[])
      : step.next ? [step.next as string] : [];

    // — 2. Validate all next references
    for (const nxt of nexts) {
      if (!stepMap.has(nxt)) {
        results.push({
          severity: 'error',
          stepId: step.id,
          rule: 'broken-next-reference',
          message: `Step "${step.id}" references unknown next step "${nxt}"`,
        });
      }
    }

    // — 5. Condition/branch step next[] length
    if (step.type === 'condition' && nexts.length !== 2) {
      results.push({
        severity: 'error',
        stepId: step.id,
        rule: 'condition-next-length',
        message: `Condition step "${step.id}" must have exactly 2 next entries (true, false); got ${nexts.length}`,
      });
    }
    if (step.type === 'branch' && nexts.length === 0) {
      results.push({
        severity: 'warning',
        stepId: step.id,
        rule: 'branch-no-next',
        message: `Branch step "${step.id}" has no next entries — all branches will fall through`,
      });
    }
    if (step.type === 'switch' && nexts.length === 0) {
      results.push({
        severity: 'warning',
        stepId: step.id,
        rule: 'switch-no-cases',
        message: `Switch step "${step.id}" has no next entries — switch will always fall through`,
      });
    }

    // — 6. Parallel with no handlers
    if (step.type === 'parallel') {
      const lanes = step.config?.['lanes'] as Record<string, string> | undefined;
      const parallelHandlers = step.config?.['parallelHandlers'] as string[] | undefined;
      if (!lanes && (!parallelHandlers || parallelHandlers.length === 0)) {
        results.push({
          severity: 'warning',
          stepId: step.id,
          rule: 'parallel-no-handlers',
          message: `Parallel step "${step.id}" has neither lanes nor parallelHandlers configured`,
        });
      }
    }

    // — 7. Non-terminal steps missing next
    const isTerminalType = step.type === 'wait' || step.type === 'human-task';
    if (!isTerminalType && nexts.length === 0 && step.type !== 'condition' && step.type !== 'branch' && step.type !== 'switch') {
      // Last step in the flow is fine (no next = terminal), only warn if there are other steps
      if (def.steps.length > 1 && step.id !== def.steps[def.steps.length - 1]?.id) {
        results.push({
          severity: 'warning',
          stepId: step.id,
          rule: 'missing-next',
          message: `Step "${step.id}" has no "next" — it will terminate the run when reached (may be intentional)`,
        });
      }
    }

    // — 8. Missing handler for non-script deterministic steps
    if (!step.handler && step.type === 'deterministic') {
      results.push({
        severity: 'warning',
        stepId: step.id,
        rule: 'missing-handler',
        message: `Deterministic step "${step.id}" has no handler set`,
      });
    }
    if (!step.handler && step.type === 'agentic') {
      results.push({
        severity: 'warning',
        stepId: step.id,
        rule: 'missing-handler',
        message: `Agentic step "${step.id}" has no handler set`,
      });
    }
  }

  // — 3. Unreachable steps via DFS
  const reachable = new Set<string>();
  const dfsStack = [def.entryStepId];
  while (dfsStack.length > 0) {
    const id = dfsStack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const step = stepMap.get(id);
    if (!step) continue;
    const nexts = Array.isArray(step.next)
      ? (step.next as string[])
      : step.next ? [step.next as string] : [];
    for (const nxt of nexts) {
      if (!reachable.has(nxt)) dfsStack.push(nxt);
    }
    // Also traverse onError targets
    if (step.onError && !reachable.has(step.onError as string)) {
      dfsStack.push(step.onError as string);
    }
  }
  for (const step of def.steps) {
    if (!reachable.has(step.id)) {
      results.push({
        severity: 'warning',
        stepId: step.id,
        rule: 'unreachable-step',
        message: `Step "${step.id}" is unreachable from entry step "${def.entryStepId}"`,
      });
    }
  }

  // — 4. Cycle detection (DFS with recursion stack)
  const visited = new Set<string>();
  const recStack = new Set<string>();
  function hasCycle(id: string): boolean {
    visited.add(id);
    recStack.add(id);
    const step = stepMap.get(id);
    if (!step) { recStack.delete(id); return false; }
    const nexts = Array.isArray(step.next)
      ? (step.next as string[])
      : step.next ? [step.next as string] : [];
    for (const nxt of nexts) {
      if (!visited.has(nxt)) {
        if (hasCycle(nxt)) return true;
      } else if (recStack.has(nxt)) {
        return true;
      }
    }
    recStack.delete(id);
    return false;
  }
  for (const step of def.steps) {
    if (!visited.has(step.id)) {
      if (hasCycle(step.id)) {
        results.push({
          severity: 'error',
          stepId: step.id,
          rule: 'circular-reference',
          message: `Step "${step.id}" is part of a cycle in the step graph`,
        });
        break; // one cycle report is enough; DFS would report duplicates
      }
    }
  }

  return results;
}

// ─── Graph builder ─────────────────────────────────────────────────────────

/**
 * Produce an adjacency list for a workflow definition.
 * Suitable for rendering in a drag-drop visual editor.
 */
export function getWorkflowGraph(def: WorkflowDefinition): WorkflowGraph {
  const nodes: WorkflowGraphNode[] = [];
  const edges: WorkflowGraphEdge[] = [];
  const stepMap = new Map<string, WorkflowStep>(def.steps.map(s => [s.id, s]));

  // Identify terminal steps (no outgoing nexts)
  const terminalIds = new Set(
    def.steps
      .filter(s => {
        const nexts = Array.isArray(s.next) ? s.next as string[] : s.next ? [s.next as string] : [];
        return nexts.length === 0;
      })
      .map(s => s.id),
  );

  for (const step of def.steps) {
    nodes.push({
      id: step.id,
      name: step.name,
      type: step.type,
      handler: step.handler,
      isEntry: step.id === def.entryStepId,
      isTerminal: terminalIds.has(step.id),
    });

    const nexts = Array.isArray(step.next)
      ? (step.next as string[])
      : step.next ? [step.next as string] : [];

    if (step.type === 'condition') {
      if (nexts[0]) edges.push({ from: step.id, to: nexts[0], label: 'true' });
      if (nexts[1]) edges.push({ from: step.id, to: nexts[1], label: 'false' });
    } else if (step.type === 'branch' || step.type === 'switch') {
      nexts.forEach((nxt, i) => {
        const label = (step.config?.['cases'] as string[] | undefined)?.[i] ?? String(i);
        edges.push({ from: step.id, to: nxt, label });
      });
    } else {
      for (const nxt of nexts) {
        edges.push({ from: step.id, to: nxt });
      }
    }
  }

  // Unreachable detection
  const reachable = new Set<string>();
  const stack = [def.entryStepId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const step = stepMap.get(id);
    if (!step) continue;
    const nexts = Array.isArray(step.next)
      ? (step.next as string[])
      : step.next ? [step.next as string] : [];
    for (const nxt of nexts) if (!reachable.has(nxt)) stack.push(nxt);
    if (step.onError) stack.push(step.onError as string);
  }

  return {
    nodes,
    edges,
    entryStepId: def.entryStepId,
    unreachableStepIds: def.steps.filter(s => !reachable.has(s.id)).map(s => s.id),
  };
}
