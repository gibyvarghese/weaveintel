// Phase 3 — Unified Trigger Dispatcher (canonical surface). New code
// should use `createTriggerDispatcher`, `Trigger`, `SourceAdapter`,
// `TargetAdapter`, and `TriggerStore` from `./dispatcher.js`.
export * from './dispatcher.js';

// Legacy event-trigger scaffold. Kept for back-compat with adopters that
// imported `EventTriggerBase` / `createTriggerRegistry` directly. New
// code should prefer the dispatcher path above. Deprecated; will be
// removed once external callers migrate.
export * from './trigger.js';
export * from './cron.js';
export * from './webhook.js';
export * from './queue.js';
export * from './change.js';
export * from './binding.js';

// DB-backed TriggerStore adapters (parity across all 5 backends).
export { weaveSqliteTriggerStore, type WeaveSqliteTriggerStoreOptions } from './sqlite-trigger-store.js';
export { weavePostgresTriggerStore, type WeavePostgresTriggerStoreOptions } from './postgres-trigger-store.js';
export { weaveMongoDbTriggerStore, type WeaveMongoDbTriggerStoreOptions } from './mongodb-trigger-store.js';
export { weaveRedisTriggerStore, type WeaveRedisTriggerStoreOptions } from './redis-trigger-store.js';
export { weaveDynamoDbTriggerStore, type WeaveDynamoDbTriggerStoreOptions } from './dynamodb-trigger-store.js';

// Phase 4 — durable per-trigger rate-limit windows backed by `runtime.persistence.kv`.
export {
  type DurableTriggerRateLimiter,
  type DurableTriggerRateLimiterOptions,
  createDurableTriggerRateLimiter,
} from './durable-rate-limit.js';

// W6 — Reminder ergonomics
export {
  createReminderTrigger,
  rescheduleReminder,
  ReminderBusTargetAdapter,
  type CreateReminderTriggerInput,
} from './reminders.js';
