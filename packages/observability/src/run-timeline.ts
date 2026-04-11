/**
 * Run timeline — tracks temporal sequence of agent runs for visualization
 */

export interface TimelineEntry {
  runId: string;
  agentName: string;
  startTime: number;
  endTime?: number;
  status: 'running' | 'completed' | 'error';
  steps: Array<{
    name: string;
    startTime: number;
    endTime?: number;
    type: 'llm' | 'tool' | 'retrieval' | 'other';
  }>;
  metadata?: Record<string, unknown>;
}

export function weaveRunTimeline() {
  const entries = new Map<string, TimelineEntry>();

  return {
    startRun(runId: string, agentName: string, metadata?: Record<string, unknown>) {
      entries.set(runId, {
        runId,
        agentName,
        startTime: Date.now(),
        status: 'running',
        steps: [],
        metadata,
      });
    },

    addStep(runId: string, name: string, type: TimelineEntry['steps'][number]['type'] = 'other') {
      const entry = entries.get(runId);
      if (!entry) return;
      // Close previous step
      const prev = entry.steps[entry.steps.length - 1];
      if (prev && !prev.endTime) prev.endTime = Date.now();
      entry.steps.push({ name, startTime: Date.now(), type });
    },

    endStep(runId: string) {
      const entry = entries.get(runId);
      if (!entry) return;
      const last = entry.steps[entry.steps.length - 1];
      if (last && !last.endTime) last.endTime = Date.now();
    },

    endRun(runId: string, status: 'completed' | 'error' = 'completed') {
      const entry = entries.get(runId);
      if (!entry) return;
      entry.endTime = Date.now();
      entry.status = status;
      // Close any open steps
      for (const step of entry.steps) {
        if (!step.endTime) step.endTime = entry.endTime;
      }
    },

    getRun(runId: string): TimelineEntry | undefined {
      return entries.get(runId);
    },

    getAll(): TimelineEntry[] {
      return [...entries.values()];
    },

    getRecent(limit: number = 20): TimelineEntry[] {
      return [...entries.values()]
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, limit);
    },

    clear() {
      entries.clear();
    },
  };
}

export type RunTimeline = ReturnType<typeof weaveRunTimeline>;
