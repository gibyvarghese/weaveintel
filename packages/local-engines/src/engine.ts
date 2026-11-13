// SPDX-License-Identifier: MIT
/**
 * The engine contract: what every local engine (a stub, Chrome's built-in AI, later an in-browser encoder or a
 * desktop bridge) offers the chain walker.
 *
 * An engine is untrusted compute. Its output is checked like text a person typed, becomes a suggestion, and decides
 * nothing. What it says about itself (version, weights hash) is recorded, never trusted.
 */

import type { EngineClass, FallbackReason } from './constants.js';
import type { TicketFile } from './ticket.js';

/** The four states Chrome's built-in AI reports, used by every engine. */
export const AVAILABILITY_STATES = [
  'available',
  'downloadable',
  'downloading',
  'unavailable',
] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export interface EngineAvailability {
  readonly state: AvailabilityState;
  /** Size of the download still needed, when the engine knows it. */
  readonly downloadMb?: number;
  /** A short machine-readable note, recorded on the attempt (for example `api_missing`). */
  readonly detail?: string;
}

/**
 * What a task reads. The walker passes only the fields the ticket lists; `text` is the content the task works on
 * (already assembled by the host from those fields).
 */
export interface EngineInput {
  readonly text?: string;
  readonly fields?: Readonly<Record<string, string>>;
  /** `field.suggest`: the field a value is wanted for. */
  readonly field?: string;
  /** `field.suggest` and `record.classify`: the only values an answer may take. */
  readonly choices?: readonly string[];
  /** `text.translate`. */
  readonly sourceLanguage?: string;
  readonly targetLanguage?: string;
}

export interface EngineCheckRequest {
  readonly task: string;
  readonly modelKey: string;
  readonly input: EngineInput;
  readonly signal: AbortSignal;
}

export interface EngineRunRequest extends EngineCheckRequest {
  /** Pinned files for this step; an engine that loads files checks them with `verifyFileBytes` before use. */
  readonly files: readonly TicketFile[];
  readonly maxOutputChars: number;
  /**
   * True only when the walker's download gate passed (policy, budget and the person's yes). An engine must not start
   * a download when this is false.
   */
  readonly allowDownload: boolean;
}

export interface EngineRunResult {
  readonly output: unknown;
  /** 0 to 1, when the engine has one. */
  readonly confidence?: number;
  /** What the engine says it ran (recorded, never trusted). */
  readonly observedVersion?: string;
  readonly weightsSha256?: string;
}

export interface LocalEngine {
  readonly engineClass: EngineClass;
  /** A stable id for logs (`stub`, `chrome-builtin`, ...). */
  readonly id: string;
  /** Whether the engine can do this task with this model key at all (no device check). */
  supports(task: string, modelKey: string): boolean;
  /** The device state for this task. Must never start a download. */
  availability(req: EngineCheckRequest): Promise<EngineAvailability>;
  run(req: EngineRunRequest): Promise<EngineRunResult>;
}

/** An engine failure that already knows its fallback reason. */
export class EngineError extends Error {
  readonly reason: FallbackReason;
  readonly detail: string | undefined;
  constructor(reason: FallbackReason, message: string, detail?: string) {
    super(message);
    this.name = 'EngineError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Map anything an engine throws to a fallback reason. Built-in browser APIs throw `DOMException`s: `AbortError` or
 * `TimeoutError` (timeout), `QuotaExceededError` (out of memory or disk), `NotSupportedError` (not applicable),
 * `NotAllowedError` (blocked by browser or device policy). Anything else is `unavailable`.
 */
export function classifyEngineError(err: unknown): { reason: FallbackReason; detail?: string } {
  if (err instanceof EngineError) {
    return err.detail === undefined
      ? { reason: err.reason }
      : { reason: err.reason, detail: err.detail };
  }
  if (typeof err !== 'object' || err === null) return { reason: 'unavailable', detail: 'error' };
  const name = String((err as { name?: unknown }).name ?? '');
  const message = String((err as { message?: unknown }).message ?? '');
  const detail = name || 'error';
  switch (name) {
    case 'AbortError':
    case 'TimeoutError':
      return { reason: 'timeout', detail };
    case 'QuotaExceededError':
      return { reason: 'out_of_memory', detail };
    case 'NotSupportedError':
      return { reason: 'not_applicable', detail };
    case 'NotAllowedError':
      return { reason: 'device_policy_blocked', detail };
    default:
      break;
  }
  if (/out of memory|allocation failed|\boom\b/i.test(message))
    return { reason: 'out_of_memory', detail };
  return { reason: 'unavailable', detail };
}
