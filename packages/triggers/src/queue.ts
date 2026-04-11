import type { TriggerDefinition, TriggerHandler } from './trigger.js';
import { EventTriggerBase } from './trigger.js';

export interface QueueConfig {
  readonly queueName: string;
  /** Max concurrent message handlers */
  readonly concurrency?: number;
  /** Visibility timeout in ms — how long before a failed message is retried */
  readonly visibilityTimeoutMs?: number;
  /** Polling interval in ms */
  readonly pollIntervalMs?: number;
}

export interface QueueMessage {
  readonly id: string;
  readonly body: Record<string, unknown>;
  readonly receivedAt: number;
  readonly attempts: number;
}

export class QueueTrigger extends EventTriggerBase {
  private readonly config: QueueConfig;
  private readonly pending: QueueMessage[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeCount = 0;

  constructor(definition: TriggerDefinition, handler: TriggerHandler) {
    super(definition, handler);
    this.config = definition.config as unknown as QueueConfig;
  }

  get queueName(): string { return this.config.queueName; }

  /** Enqueue a message for processing */
  enqueue(message: Omit<QueueMessage, 'receivedAt' | 'attempts'>): void {
    this.pending.push({ ...message, receivedAt: Date.now(), attempts: 0 });
  }

  override start(): void {
    super.start();
    const pollMs = this.config.pollIntervalMs ?? 1000;
    this.timer = setInterval(() => { void this.processPending(); }, pollMs);
  }

  override stop(): void {
    super.stop();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async processPending(): Promise<void> {
    const maxConcurrency = this.config.concurrency ?? 1;
    while (this.pending.length > 0 && this.activeCount < maxConcurrency) {
      const msg = this.pending.shift();
      if (!msg) break;
      this.activeCount++;
      try {
        await this.fire({ queueName: this.config.queueName, messageId: msg.id, body: msg.body, attempts: msg.attempts });
      } catch {
        this.pending.push({ ...msg, attempts: msg.attempts + 1 });
      } finally {
        this.activeCount--;
      }
    }
  }
}

export function createQueueTrigger(definition: TriggerDefinition, handler: TriggerHandler): QueueTrigger {
  return new QueueTrigger(definition, handler);
}
