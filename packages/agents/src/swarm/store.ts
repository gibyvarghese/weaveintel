// SPDX-License-Identifier: MIT
/**
 * @weaveintel/agents — swarm: the default, in-memory run store.
 *
 * The engine writes every change of state through the `SwarmRunStore` port. A
 * host that wants runs to survive a restart implements the same port on its
 * own tables. This one keeps deep copies, so a test that reads the store sees
 * what was written and not a live object the engine later mutated.
 */

import type { RunEventEnvelope } from '@weaveintel/core';
import type {
  SwarmCostEntry,
  SwarmRunRecord,
  SwarmRunSnapshot,
  SwarmRunStore,
  SwarmTask,
  SwarmWorkerResult,
} from './types.js';

const copy = <T>(v: T): T => structuredClone(v);

export interface InMemorySwarmRunStore extends SwarmRunStore {
  /** Events of one run, in order. For tests and small hosts. */
  events(runId: string): readonly RunEventEnvelope[];
  costs(runId: string): readonly SwarmCostEntry[];
}

export function createInMemorySwarmRunStore(): InMemorySwarmRunStore {
  const runs = new Map<string, SwarmRunRecord>();
  const tasks = new Map<string, Map<string, SwarmTask>>();
  const results = new Map<string, SwarmWorkerResult[]>();
  const events = new Map<string, RunEventEnvelope[]>();
  const costs = new Map<string, SwarmCostEntry[]>();

  return {
    async createRun(run) {
      if (runs.has(run.runId)) throw new Error(`swarm run "${run.runId}" already exists`);
      runs.set(run.runId, copy(run));
    },
    async updateRun(runId, run) {
      if (!runs.has(runId)) throw new Error(`swarm run "${runId}" does not exist`);
      runs.set(runId, copy(run));
    },
    async putTask(runId, task) {
      const m = tasks.get(runId) ?? new Map<string, SwarmTask>();
      m.set(task.key, copy(task));
      tasks.set(runId, m);
    },
    async putResult(runId, result) {
      const list = results.get(runId) ?? [];
      list.push(copy(result));
      results.set(runId, list);
    },
    async appendEvent(event) {
      const list = events.get(event.runId) ?? [];
      list.push(copy(event));
      events.set(event.runId, list);
    },
    async recordCost(entry) {
      const list = costs.get(entry.runId) ?? [];
      list.push(copy(entry));
      costs.set(entry.runId, list);
    },
    async load(runId): Promise<SwarmRunSnapshot | undefined> {
      const run = runs.get(runId);
      if (!run) return undefined;
      const evs = events.get(runId) ?? [];
      return {
        run: copy(run),
        tasks: [...(tasks.get(runId)?.values() ?? [])].map(copy).sort((a, b) => a.position - b.position),
        results: (results.get(runId) ?? []).map(copy),
        lastSequence: evs.length === 0 ? 0 : evs[evs.length - 1]!.sequence,
      };
    },
    events(runId) { return (events.get(runId) ?? []).map(copy); },
    costs(runId) { return (costs.get(runId) ?? []).map(copy); },
  };
}

/**
 * Flag a run that was mid-flight when its process died. A host calls this at
 * boot for every run its store still shows as running; the run can then be
 * offered for resume. Returns false when the run was not in flight.
 */
export async function markSwarmInterrupted(store: SwarmRunStore, runId: string, now: () => number = Date.now): Promise<boolean> {
  const snap = await store.load(runId);
  if (!snap) return false;
  if (snap.run.status !== 'running' && snap.run.status !== 'pending') return false;
  const run: SwarmRunRecord = {
    ...snap.run,
    status: 'interrupted',
    stopReason: 'interrupted',
    stopDetail: 'The run was in flight when the process stopped. It can be resumed; finished work is kept.',
  };
  await store.updateRun(runId, run);
  await store.appendEvent({
    runId,
    sequence: snap.lastSequence + 1,
    kind: 'diagnostic',
    payload: { channel: 'swarm', data: { type: 'swarm.interrupted' } },
    timestamp: now(),
  });
  return true;
}
