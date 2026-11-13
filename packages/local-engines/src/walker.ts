// SPDX-License-Identifier: MIT
/**
 * The chain walker: try each local step of a verified ticket in order, skip or fail with one reason per step, and
 * stop at the first local success or at the hosted end of the chain.
 *
 * The walker never runs a hosted step. It hands the hosted end back to the caller, who makes the normal hosted call
 * carrying the ticket id, so the server knows why the device fell back (and applies its own prompt gate to that call,
 * whatever the device did).
 *
 * The order of checks per local step:
 *   1. an engine for the class that supports the task and model      else `not_applicable`
 *   2. offline: the step and the policy must both allow it           else `offline`
 *   3. battery below the floor and not charging                      → `device_policy_blocked`
 *   4. availability (bounded by the step's timeout)                  `unavailable` / `timeout`
 *   5. a download is needed: metered + unmetered-only                → `device_policy_blocked`
 *                            size unknown or over the step / budget  → `over_budget`
 *                            no yes from the person                  → `download_refused`
 *      (the person's answer is not timed; only the caller's signal ends it)
 *   6. run (bounded by the step's timeout again)                     `timeout`, `out_of_memory`, ...
 *   7. output check                                                  else `schema_violation`
 *   8. confidence floor                                              else `low_confidence`
 */

import { HOSTED_ENGINE_CLASSES, type EngineClass, type FallbackReason } from './constants.js';
import {
  classifyEngineError,
  type EngineInput,
  type EngineRunResult,
  type LocalEngine,
} from './engine.js';
import { DEFAULT_DEVICE_POLICY, type DevicePolicy, type DeviceState } from './probe.js';
import {
  verifyTicket,
  type ChainStep,
  type RoutingTicket,
  type TicketRefusalCode,
  type TicketSignatureVerifier,
} from './ticket.js';
import { validateTaskOutput, type OutputValidator } from './validate.js';

/** One step tried (or skipped). Mirrors the host's attempt row; `attested` is always false from a web page. */
export interface Attempt {
  readonly position: number;
  readonly engineClass: EngineClass;
  readonly modelKey: string;
  /** `skipped`: never ran. `failed`: ran and was not usable. `ok`: the answer. `hosted`: handed to the caller. */
  readonly outcome: 'ok' | 'skipped' | 'failed' | 'hosted';
  readonly reason?: FallbackReason;
  readonly detail?: string;
  readonly latencyMs: number;
  readonly confidence?: number;
  readonly observedVersion?: string;
  readonly weightsSha256?: string;
  readonly attested: false;
}

export interface DownloadRequest {
  readonly engineClass: EngineClass;
  readonly modelKey: string;
  readonly downloadMb: number;
}

export interface WalkOptions {
  readonly ticket: RoutingTicket;
  readonly engines: readonly LocalEngine[];
  readonly input: EngineInput;
  readonly device: DeviceState;
  /** Defaults to {@link DEFAULT_DEVICE_POLICY} (no downloads). */
  readonly policy?: DevicePolicy;
  /** Ask the person before a download. Absent means every download is refused. */
  readonly confirmDownload?: (req: DownloadRequest) => boolean | Promise<boolean>;
  readonly verifySignature?: TicketSignatureVerifier;
  readonly requireSignature?: boolean;
  /** Longest input text a local engine may be handed. Longer input skips every local step (`not_applicable`). */
  readonly maxInputChars?: number;
  /** Default 4000. */
  readonly maxOutputChars?: number;
  /** Validators for tasks this package does not know, or to override one it does. */
  readonly validators?: Readonly<Record<string, OutputValidator>>;
  readonly onAttempt?: (attempt: Attempt) => void;
  /** The caller gave up (the person left the page). */
  readonly signal?: AbortSignal;
  /** Milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

export type WalkResult =
  | {
      readonly kind: 'local';
      readonly ticketId: string;
      readonly position: number;
      readonly engineClass: EngineClass;
      readonly modelKey: string;
      readonly output: unknown;
      readonly confidence?: number;
      readonly attempts: readonly Attempt[];
    }
  | {
      readonly kind: 'hosted';
      readonly ticketId: string;
      readonly position: number;
      readonly engineClass: EngineClass;
      readonly attempts: readonly Attempt[];
    }
  | {
      /** A local-only chain where no step worked. */
      readonly kind: 'exhausted';
      readonly ticketId: string;
      readonly message: string;
      readonly attempts: readonly Attempt[];
    }
  | {
      /** The ticket failed its checks; nothing ran. */
      readonly kind: 'refused';
      readonly ticketId?: string;
      readonly code: TicketRefusalCode;
      readonly message: string;
      readonly attempts: readonly Attempt[];
    }
  | {
      readonly kind: 'cancelled';
      readonly ticketId: string;
      readonly attempts: readonly Attempt[];
    };

/** Walk a ticket's chain. Never throws for engine trouble; every failure is an attempt with a reason. */
export async function walkChain(opts: WalkOptions): Promise<WalkResult> {
  const now = opts.now ?? Date.now;
  const policy = opts.policy ?? DEFAULT_DEVICE_POLICY;
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const device = opts.device;
  const raw: unknown = opts.ticket;
  const rawId =
    typeof raw === 'object' && raw !== null ? (raw as { ticketId?: unknown }).ticketId : undefined;

  const check = await verifyTicket(raw, {
    shell: device.shell,
    now: now(),
    ...(opts.verifySignature ? { verifySignature: opts.verifySignature } : {}),
    ...(opts.requireSignature ? { requireSignature: true } : {}),
  });
  if (!check.ok) {
    return {
      kind: 'refused',
      ...(typeof rawId === 'string' ? { ticketId: rawId } : {}),
      code: check.code,
      message: check.message,
      attempts: [],
    };
  }

  const ticket = opts.ticket;
  const ticketId = ticket.ticketId;
  const attempts: Attempt[] = [];
  const cancelled = (): WalkResult => ({ kind: 'cancelled', ticketId, attempts });
  const input = limitInput(opts.input, ticket.fields);
  const tooLong = opts.maxInputChars !== undefined && inputLength(input) > opts.maxInputChars;

  for (const s of ticket.steps) {
    if (opts.signal?.aborted) return cancelled();
    const started = now();
    const record = (
      a: Omit<Attempt, 'position' | 'engineClass' | 'modelKey' | 'latencyMs' | 'attested'>,
    ) => {
      const attempt = clean({
        position: s.position,
        engineClass: s.engineClass,
        modelKey: s.modelKey,
        latencyMs: Math.max(0, now() - started),
        attested: false as const,
        ...a,
      });
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
    };
    const skip = (reason: FallbackReason, detail?: string) =>
      record({ outcome: 'skipped', reason, detail });
    const fail = (reason: FallbackReason, detail?: string, extra: Partial<Attempt> = {}) =>
      record({ outcome: 'failed', reason, detail, ...extra });

    // The hosted end: hand it back. The walker never runs a hosted step, whatever engine claims the class.
    if (HOSTED_ENGINE_CLASSES.has(s.engineClass)) {
      record({ outcome: 'hosted' });
      return {
        kind: 'hosted',
        ticketId,
        position: s.position,
        engineClass: s.engineClass,
        attempts,
      };
    }

    if (tooLong) {
      skip('not_applicable', 'input_too_long');
      continue;
    }
    const sameClass = opts.engines.filter((e) => e.engineClass === s.engineClass);
    const engine = sameClass.find((e) => {
      try {
        return e.supports(ticket.task, s.modelKey);
      } catch {
        return false;
      }
    });
    if (!engine) {
      skip('not_applicable', sameClass.length > 0 ? 'task_not_supported' : 'no_engine');
      continue;
    }
    if (!device.online && !(s.offlineOk && policy.allowOffline)) {
      skip('offline');
      continue;
    }
    if (
      policy.minBatteryPct > 0 &&
      typeof device.batteryPct === 'number' &&
      device.batteryPct < policy.minBatteryPct &&
      device.charging !== true
    ) {
      skip('device_policy_blocked', 'battery_low');
      continue;
    }

    // Availability, bounded by the step's timeout. Never a download.
    const checkScope = stepScope(s.timeoutMs, opts.signal);
    let state: string;
    let downloadMb: number | undefined;
    try {
      const a = await checkScope.bounded(
        engine.availability({
          task: ticket.task,
          modelKey: s.modelKey,
          input,
          signal: checkScope.signal,
        }),
      );
      state = a.state;
      downloadMb = a.downloadMb;
      if (a.state === 'unavailable') {
        skip('unavailable', a.detail);
        continue;
      }
    } catch (err) {
      if (opts.signal?.aborted) return cancelled();
      const r = classifyEngineError(err);
      skip(r.reason, r.detail);
      continue;
    } finally {
      checkScope.dispose();
    }

    let allowDownload = false;
    if (state === 'downloading') {
      skip('unavailable', 'downloading');
      continue;
    }
    if (state === 'downloadable') {
      const gate = downloadGate(s, policy, device, downloadMb);
      if (gate) {
        skip(gate.reason, gate.detail);
        continue;
      }
      let yes = false;
      try {
        yes = opts.confirmDownload
          ? (await untilCancelled(
              Promise.resolve(
                opts.confirmDownload({
                  engineClass: s.engineClass,
                  modelKey: s.modelKey,
                  downloadMb: downloadMb ?? 0,
                }),
              ),
              opts.signal,
            )) === true
          : false;
      } catch {
        if (opts.signal?.aborted) return cancelled();
        yes = false;
      }
      if (!yes) {
        skip('download_refused');
        continue;
      }
      allowDownload = true;
    } else if (state !== 'available') {
      skip('unavailable', 'unknown_state');
      continue;
    }

    // Run, bounded by the step's timeout.
    const runScope = stepScope(s.timeoutMs, opts.signal);
    let result: EngineRunResult;
    try {
      result = await runScope.bounded(
        engine.run({
          task: ticket.task,
          modelKey: s.modelKey,
          input,
          signal: runScope.signal,
          files: s.files,
          maxOutputChars,
          allowDownload,
        }),
      );
    } catch (err) {
      if (opts.signal?.aborted) return cancelled();
      const r = classifyEngineError(err);
      fail(r.reason, r.detail);
      continue;
    } finally {
      runScope.dispose();
    }

    const told = clean({
      observedVersion: result.observedVersion,
      weightsSha256: result.weightsSha256,
    });
    const checked = validateTaskOutput(
      ticket.task,
      result.output,
      { input, maxOutputChars },
      opts.validators,
    );
    if (!checked.ok) {
      fail('schema_violation', checked.problem, told);
      continue;
    }
    const confidence = result.confidence;
    if (
      confidence !== undefined &&
      !(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)
    ) {
      fail('schema_violation', 'The confidence is not between 0 and 1.', told);
      continue;
    }
    if (s.minConfidence > 0 && (confidence === undefined || confidence < s.minConfidence)) {
      fail('low_confidence', confidence === undefined ? 'no_confidence' : undefined, {
        ...told,
        ...clean({ confidence }),
      });
      continue;
    }
    record({ outcome: 'ok', ...told, ...clean({ confidence }) });
    return clean({
      kind: 'local' as const,
      ticketId,
      position: s.position,
      engineClass: s.engineClass,
      modelKey: s.modelKey,
      output: checked.output,
      confidence,
      attempts,
    });
  }

  // Only a local-only chain gets here: verification refuses any other chain without a hosted end.
  return {
    kind: 'exhausted',
    ticketId,
    message:
      'No engine on this device could do this, and this task is set to local only, so nothing was sent to a hosted model.',
    attempts,
  };
}

const DEFAULT_MAX_OUTPUT_CHARS = 4000;

/** Keep only the fields the ticket lists. `text` is the host's assembly of those fields and passes as is. */
function limitInput(input: EngineInput, allowed: readonly string[]): EngineInput {
  if (!input.fields) return input;
  const keep = new Set(allowed);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fields)) if (keep.has(k)) fields[k] = v;
  return { ...input, fields };
}

function inputLength(input: EngineInput): number {
  let n = input.text?.length ?? 0;
  for (const v of Object.values(input.fields ?? {})) n += v.length;
  return n;
}

function downloadGate(
  s: ChainStep,
  policy: DevicePolicy,
  device: DeviceState,
  downloadMb: number | undefined,
): { reason: FallbackReason; detail: string } | undefined {
  if (policy.requireUnmetered && device.metered === true)
    return { reason: 'device_policy_blocked', detail: 'metered' };
  if (downloadMb === undefined || !Number.isFinite(downloadMb) || downloadMb < 0) {
    return { reason: 'over_budget', detail: 'size_unknown' };
  }
  if (downloadMb > s.maxDownloadMb) return { reason: 'over_budget', detail: 'over_step_limit' };
  if (downloadMb > policy.downloadBudgetMb - (device.downloadedMb ?? 0)) {
    return { reason: 'over_budget', detail: 'over_device_budget' };
  }
  return undefined;
}

interface StepScope {
  readonly signal: AbortSignal;
  bounded<T>(p: Promise<T>): Promise<T>;
  dispose(): void;
}

/**
 * An abort signal that fires at the step's timeout (reason `TimeoutError`) or when the caller gives up (reason
 * `AbortError`), and a race against it. The rejection carries that reason, so it classifies as `timeout`.
 */
function stepScope(timeoutMs: number, outer?: AbortSignal): StepScope {
  const ctl = new AbortController();
  const timer = setTimeout(() => {
    ctl.abort(new DOMException('The step timed out.', 'TimeoutError'));
  }, timeoutMs);
  const onOuter = () => ctl.abort(new DOMException('The walk was cancelled.', 'AbortError'));
  if (outer?.aborted) onOuter();
  else outer?.addEventListener('abort', onOuter, { once: true });
  return {
    signal: ctl.signal,
    bounded: (p) => untilCancelled(p, ctl.signal),
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    },
  };
}

function untilCancelled<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Drop keys whose value is undefined, so records and results carry only what is known. */
function clean<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** `engineClass:reason` for each step that did not answer, in order (the form the host's event log shows). */
export function fallbackSummary(attempts: readonly Attempt[]): string[] {
  return attempts
    .filter((a) => a.outcome === 'skipped' || a.outcome === 'failed')
    .map((a) => `${a.engineClass}:${a.reason ?? 'unavailable'}`);
}

/** What a device posts with a local answer. The server checks the ticket again and stores it as a suggestion. */
export interface LocalResultSubmission {
  readonly ticketId: string;
  readonly step: number;
  readonly output: unknown;
  readonly confidence?: number;
  readonly provenance: {
    readonly engineClass: EngineClass;
    readonly modelKey: string;
    readonly observedVersion?: string;
    readonly weightsSha256?: string;
    readonly attested: false;
  };
  readonly attempts: readonly Attempt[];
}

/** What a device attaches to the hosted call when it fell back. */
export interface HostedFallbackNote {
  readonly ticketId: string;
  readonly step: number;
  readonly fallback: readonly string[];
  readonly attempts: readonly Attempt[];
}

/** The local answer as the device posts it. Provenance is what the engine said; it is never attested from a page. */
export function toResultSubmission(
  result: Extract<WalkResult, { kind: 'local' }>,
): LocalResultSubmission {
  const ok = [...result.attempts]
    .reverse()
    .find((a) => a.outcome === 'ok' && a.position === result.position);
  return clean({
    ticketId: result.ticketId,
    step: result.position,
    output: result.output,
    confidence: result.confidence,
    provenance: clean({
      engineClass: result.engineClass,
      modelKey: result.modelKey,
      observedVersion: ok?.observedVersion,
      weightsSha256: ok?.weightsSha256,
      attested: false as const,
    }),
    attempts: result.attempts,
  });
}

/** The note a device attaches to the hosted call, so the server knows which step it reached and why. */
export function toHostedFallback(
  result: Extract<WalkResult, { kind: 'hosted' }>,
): HostedFallbackNote {
  return {
    ticketId: result.ticketId,
    step: result.position,
    fallback: fallbackSummary(result.attempts),
    attempts: result.attempts,
  };
}
