import type { ExecutionContext } from '@weaveintel/core';

export type TriggerType = 'cron' | 'webhook' | 'queue' | 'change' | 'event' | 'custom';
export type TriggerStatus = 'active' | 'paused' | 'disabled' | 'error';

export interface TriggerDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly type: TriggerType;
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface TriggerContext {
  readonly triggerId: string;
  readonly triggerType: TriggerType;
  readonly firedAt: number;
  readonly payload: Record<string, unknown>;
}

export type TriggerHandler = (ctx: ExecutionContext, trigger: TriggerContext) => Promise<void>;

export interface EventTrigger {
  readonly definition: TriggerDefinition;
  readonly status: TriggerStatus;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
}

export class EventTriggerBase implements EventTrigger {
  readonly definition: TriggerDefinition;
  private _status: TriggerStatus = 'disabled';
  protected handler: TriggerHandler;

  constructor(definition: TriggerDefinition, handler: TriggerHandler) {
    this.definition = definition;
    this.handler = handler;
  }

  get status(): TriggerStatus { return this._status; }

  start(): void { this._status = 'active'; }
  stop(): void { this._status = 'disabled'; }
  pause(): void { if (this._status === 'active') this._status = 'paused'; }
  resume(): void { if (this._status === 'paused') this._status = 'active'; }

  protected async fire(payload: Record<string, unknown>): Promise<void> {
    if (this._status !== 'active') return;
    const ctx: ExecutionContext = {
      executionId: `trigger-${this.definition.id}-${Date.now()}`,
      metadata: { triggerId: this.definition.id },
    };
    const triggerCtx: TriggerContext = {
      triggerId: this.definition.id,
      triggerType: this.definition.type,
      firedAt: Date.now(),
      payload,
    };
    try {
      await this.handler(ctx, triggerCtx);
    } catch {
      this._status = 'error';
    }
  }
}
