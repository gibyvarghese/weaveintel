import type { TriggerDefinition, TriggerHandler } from './trigger.js';
import { EventTriggerBase } from './trigger.js';

export interface CronConfig {
  /** Cron expression (e.g., every 5 minutes) */
  readonly expression: string;
  /** Timezone (e.g., 'UTC') */
  readonly timezone?: string;
  /** Skip if previous execution is still running */
  readonly skipIfRunning?: boolean;
}

export class CronTrigger extends EventTriggerBase {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private running = false;
  private readonly skipIfRunning: boolean;

  constructor(definition: TriggerDefinition, handler: TriggerHandler) {
    super(definition, handler);
    const config = definition.config as unknown as CronConfig;
    this.intervalMs = parseCronToMs(config.expression);
    this.skipIfRunning = config.skipIfRunning ?? false;
  }

  override start(): void {
    super.start();
    this.timer = setInterval(async () => {
      if (this.skipIfRunning && this.running) return;
      this.running = true;
      try {
        await this.fire({ cronExpression: (this.definition.config as unknown as CronConfig).expression, scheduledAt: Date.now() });
      } finally {
        this.running = false;
      }
    }, this.intervalMs);
  }

  override stop(): void {
    super.stop();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

function parseCronToMs(expr: string): number {
  const parts = expr.trim().split(/\s+/);
  const first = parts[0] ?? '';
  const match = /^\*\/(\d+)$/.exec(first);
  if (match) {
    const n = parseInt(match[1]!, 10);
    return parts.length >= 6 ? n * 1000 : n * 60_000;
  }
  return 60_000;
}

export function createCronTrigger(definition: TriggerDefinition, handler: TriggerHandler): CronTrigger {
  return new CronTrigger(definition, handler);
}
