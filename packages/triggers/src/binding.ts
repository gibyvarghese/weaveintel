import type { EventTrigger, TriggerDefinition, TriggerHandler } from './trigger.js';
import { CronTrigger } from './cron.js';
import { WebhookTrigger } from './webhook.js';
import { QueueTrigger } from './queue.js';
import { ChangeTrigger } from './change.js';

export interface WorkflowBinding {
  readonly trigger: EventTrigger;
  readonly workflowId: string;
}

export interface TriggerRegistry {
  readonly bindings: ReadonlyMap<string, WorkflowBinding>;
  register(definition: TriggerDefinition, workflowId: string, handler: TriggerHandler): WorkflowBinding;
  unregister(triggerId: string): void;
  startAll(): void;
  stopAll(): void;
  getByType(type: string): WorkflowBinding[];
}

export function createTriggerRegistry(): TriggerRegistry {
  const bindings = new Map<string, WorkflowBinding>();

  function createTriggerInstance(def: TriggerDefinition, handler: TriggerHandler): EventTrigger {
    switch (def.type) {
      case 'cron': return new CronTrigger(def, handler);
      case 'webhook': return new WebhookTrigger(def, handler);
      case 'queue': return new QueueTrigger(def, handler);
      case 'change': return new ChangeTrigger(def, handler);
      default: throw new Error(`Unknown trigger type: ${def.type}`);
    }
  }

  return {
    get bindings() { return bindings as ReadonlyMap<string, WorkflowBinding>; },

    register(definition, workflowId, handler) {
      const trigger = createTriggerInstance(definition, handler);
      const binding: WorkflowBinding = { trigger, workflowId };
      bindings.set(definition.id, binding);
      return binding;
    },

    unregister(triggerId) {
      const binding = bindings.get(triggerId);
      if (binding) {
        binding.trigger.stop();
        bindings.delete(triggerId);
      }
    },

    startAll() {
      for (const b of bindings.values()) b.trigger.start();
    },

    stopAll() {
      for (const b of bindings.values()) b.trigger.stop();
    },

    getByType(type) {
      return [...bindings.values()].filter(b => b.trigger.definition.type === type);
    },
  };
}
