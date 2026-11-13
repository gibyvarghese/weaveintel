// SPDX-License-Identifier: MIT
/**
 * The closed lists every part of the package shares: engine classes, task keys, shells, fallback reasons.
 *
 * A host application keeps its own copy of these lists in its contract; the values here are the same strings, so a
 * host type such as `'tenant-hosted' | 'stub' | ...` is assignable to {@link EngineClass} and back.
 */

/** Where one step of a chain runs. The two hosted classes are the end of a chain. */
export const ENGINE_CLASSES = [
  'stub',
  'chrome-builtin',
  'edge-builtin',
  'browser-wasm',
  'browser-webgpu',
  'os-apple',
  'os-android',
  'os-windows',
  'local-server',
  'tenant-hosted',
  'platform-hosted',
] as const;
export type EngineClass = (typeof ENGINE_CLASSES)[number];

/** The hosted end of a chain: the walker hands these back to the caller and never runs them itself. */
export const HOSTED_ENGINE_CLASSES: ReadonlySet<EngineClass> = new Set<EngineClass>([
  'tenant-hosted',
  'platform-hosted',
]);

/** True when the class runs on the person's device (everything that is not hosted). */
export function isLocalEngineClass(engineClass: EngineClass): boolean {
  return !HOSTED_ENGINE_CLASSES.has(engineClass);
}

/** Short, reviewable tasks that may run on a device. Anything else stays hosted. */
export const LOCAL_TASKS = [
  'text.language',
  'text.summary.short',
  'field.suggest',
  'record.classify',
  'pii.detect',
  'text.translate',
  'speech.text',
] as const;
export type LocalTask = (typeof LOCAL_TASKS)[number];

/** Where the chain runs: a web page, a desktop shell or a mobile app. */
export const SHELLS = ['web', 'desktop', 'mobile'] as const;
export type Shell = (typeof SHELLS)[number];

/**
 * Engines a shell may never be offered. A web page never talks to a model server on the person's machine, and never
 * to an operating-system model (it has no bridge to one). The issuing server enforces this; the client refuses a
 * ticket that breaks it as a second layer.
 */
export const ENGINES_NEVER_ON_SHELL: Readonly<Record<Shell, ReadonlySet<EngineClass>>> = {
  web: new Set<EngineClass>(['local-server', 'os-apple', 'os-android', 'os-windows']),
  desktop: new Set<EngineClass>(['os-apple', 'os-android']),
  mobile: new Set<EngineClass>(['local-server', 'os-windows']),
};

/** Why a local step was skipped or failed. One reason per attempt; the walker never invents others. */
export const FALLBACK_REASONS = [
  'unavailable',
  'download_refused',
  'over_budget',
  'out_of_memory',
  'timeout',
  'schema_violation',
  'low_confidence',
  'device_policy_blocked',
  'offline',
  'not_applicable',
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** The longest short summary a local engine may return (words). */
export const SHORT_SUMMARY_MAX_WORDS = 120;
