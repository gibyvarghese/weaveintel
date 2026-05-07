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
