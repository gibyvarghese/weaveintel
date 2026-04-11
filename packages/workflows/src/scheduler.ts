/**
 * @weaveintel/workflows — scheduler.ts
 * Cron and delayed execution for workflow triggers
 */
import type { WorkflowTrigger, WorkflowScheduler } from '@weaveintel/core';

/**
 * Callback invoked when a scheduled trigger fires.
 */
export type TriggerCallback = (trigger: WorkflowTrigger) => Promise<void>;

/**
 * In-memory scheduler — manages trigger registrations and can execute cron-like ticks.
 * For production, replace with a persistent scheduler backed by DB polling or system cron.
 */
export class InMemoryScheduler implements WorkflowScheduler {
  private triggers = new Map<string, WorkflowTrigger>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private callback: TriggerCallback;

  constructor(callback: TriggerCallback) {
    this.callback = callback;
  }

  async schedule(trigger: WorkflowTrigger): Promise<void> {
    this.triggers.set(trigger.id, trigger);
    if (trigger.type === 'cron' && trigger.enabled) {
      const intervalMs = (trigger.config['intervalMs'] as number) ?? 60_000;
      const timer = setInterval(() => {
        const t = this.triggers.get(trigger.id);
        if (t?.enabled) void this.callback(t);
      }, intervalMs);
      this.timers.set(trigger.id, timer as unknown as ReturnType<typeof setTimeout>);
    }
  }

  async cancel(triggerId: string): Promise<void> {
    this.triggers.delete(triggerId);
    const timer = this.timers.get(triggerId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(triggerId);
    }
  }

  async list(workflowId: string): Promise<WorkflowTrigger[]> {
    return [...this.triggers.values()].filter(t => t.workflowId === workflowId);
  }

  /** Manually tick all enabled triggers (useful for tests). */
  async tick(): Promise<void> {
    for (const t of this.triggers.values()) {
      if (t.enabled) await this.callback(t);
    }
  }

  /** Stop all timers (cleanup). */
  dispose(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
