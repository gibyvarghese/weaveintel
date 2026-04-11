import type { TriggerDefinition, TriggerHandler } from './trigger.js';
import { EventTriggerBase } from './trigger.js';

export interface WebhookConfig {
  /** Path suffix for the webhook endpoint (e.g., '/hooks/my-trigger') */
  readonly path: string;
  /** HTTP method to accept */
  readonly method?: 'GET' | 'POST' | 'PUT';
  /** Secret for HMAC signature verification */
  readonly secret?: string;
  /** Headers to validate */
  readonly requiredHeaders?: readonly string[];
}

export interface WebhookPayload {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly receivedAt: number;
}

export class WebhookTrigger extends EventTriggerBase {
  private readonly config: WebhookConfig;

  constructor(definition: TriggerDefinition, handler: TriggerHandler) {
    super(definition, handler);
    this.config = definition.config as unknown as WebhookConfig;
  }

  get path(): string { return this.config.path; }
  get method(): string { return this.config.method ?? 'POST'; }

  async handleRequest(payload: WebhookPayload): Promise<{ status: number; body: Record<string, unknown> }> {
    if (this.status !== 'active') {
      return { status: 503, body: { error: 'Trigger is not active' } };
    }

    const expectedMethod = this.config.method ?? 'POST';
    if (payload.method.toUpperCase() !== expectedMethod) {
      return { status: 405, body: { error: `Expected ${expectedMethod}` } };
    }

    if (this.config.requiredHeaders) {
      for (const h of this.config.requiredHeaders) {
        if (!payload.headers[h.toLowerCase()]) {
          return { status: 400, body: { error: `Missing required header: ${h}` } };
        }
      }
    }

    try {
      await this.fire({
        method: payload.method,
        path: payload.path,
        body: payload.body as Record<string, unknown>,
        receivedAt: payload.receivedAt,
      });
      return { status: 200, body: { ok: true } };
    } catch {
      return { status: 500, body: { error: 'Trigger execution failed' } };
    }
  }
}

export function createWebhookTrigger(definition: TriggerDefinition, handler: TriggerHandler): WebhookTrigger {
  return new WebhookTrigger(definition, handler);
}
