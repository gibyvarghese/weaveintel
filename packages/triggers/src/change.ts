import type { TriggerDefinition, TriggerHandler } from './trigger.js';
import { EventTriggerBase } from './trigger.js';

export type ChangeType = 'created' | 'updated' | 'deleted';

export interface ChangeConfig {
  /** Resource type to watch (e.g., 'document', 'record', 'file') */
  readonly resourceType: string;
  /** Optional filter on resource fields */
  readonly filter?: Record<string, unknown>;
  /** Change types to watch */
  readonly changeTypes?: readonly ChangeType[];
  /** Debounce window in ms (batch rapid changes) */
  readonly debounceMs?: number;
}

export interface ChangeEvent {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly changeType: ChangeType;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly changedAt: number;
}

export class ChangeTrigger extends EventTriggerBase {
  private readonly config: ChangeConfig;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges: ChangeEvent[] = [];

  constructor(definition: TriggerDefinition, handler: TriggerHandler) {
    super(definition, handler);
    this.config = definition.config as unknown as ChangeConfig;
  }

  get resourceType(): string { return this.config.resourceType; }

  /** Notify the trigger of a change event */
  async notify(event: ChangeEvent): Promise<void> {
    if (this.status !== 'active') return;
    if (event.resourceType !== this.config.resourceType) return;

    const watchedTypes = this.config.changeTypes ?? ['created', 'updated', 'deleted'];
    if (!watchedTypes.includes(event.changeType)) return;

    if (this.config.debounceMs && this.config.debounceMs > 0) {
      this.pendingChanges.push(event);
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => { void this.flushPending(); }, this.config.debounceMs);
    } else {
      await this.fire({ change: event, resourceType: event.resourceType, resourceId: event.resourceId, changeType: event.changeType });
    }
  }

  private async flushPending(): Promise<void> {
    const changes = this.pendingChanges.splice(0);
    if (changes.length === 0) return;
    await this.fire({ changes, resourceType: this.config.resourceType, batchSize: changes.length });
  }

  override stop(): void {
    super.stop();
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.pendingChanges.length = 0;
  }
}

export function createChangeTrigger(definition: TriggerDefinition, handler: TriggerHandler): ChangeTrigger {
  return new ChangeTrigger(definition, handler);
}
