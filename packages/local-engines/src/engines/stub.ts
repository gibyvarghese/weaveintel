// SPDX-License-Identifier: MIT
/**
 * The stub engine: deterministic, offline, instant (or delayed on purpose), for tests and for hosts that want to show
 * the whole chain working without any model. It never loads or runs a model.
 */

import type { EngineClass } from '../constants.js';
import type {
  AvailabilityState,
  EngineAvailability,
  EngineCheckRequest,
  EngineRunRequest,
  EngineRunResult,
  LocalEngine,
} from '../engine.js';

export interface StubEngineOptions {
  /** Default `stub`. A stub may stand in for another class in tests (for example `browser-wasm`). */
  readonly engineClass?: EngineClass;
  readonly id?: string;
  /** Tasks it answers. Default: every task. */
  readonly tasks?: readonly string[];
  /** Model keys it answers. Default: every key. */
  readonly modelKeys?: readonly string[];
  readonly availability?:
    | AvailabilityState
    | EngineAvailability
    | ((req: EngineCheckRequest) => EngineAvailability | Promise<EngineAvailability>);
  /** The answer. Default: a fixed, valid answer per known task (see {@link stubAnswer}). */
  readonly respond?: (req: EngineRunRequest) => EngineRunResult | Promise<EngineRunResult>;
  /** Wait this long before answering; the wait ends early when the run is aborted. */
  readonly delayMs?: number;
  readonly observedVersion?: string;
}

/** Every call the stub received, for assertions. */
export interface StubEngine extends LocalEngine {
  readonly calls: { readonly availability: EngineCheckRequest[]; readonly run: EngineRunRequest[] };
}

/** A fixed, valid answer for each known task. */
export function stubAnswer(req: EngineRunRequest): EngineRunResult {
  const { input } = req;
  switch (req.task) {
    case 'text.language':
      return { output: { language: 'en' }, confidence: 0.99 };
    case 'text.summary.short':
      return { output: { text: 'A short summary written by the stub engine.' } };
    case 'field.suggest': {
      const field = input.field ?? 'field';
      const value = input.choices?.[0] ?? 'value';
      return { output: { field, value, confidence: 0.9 }, confidence: 0.9 };
    }
    case 'record.classify':
      return { output: { label: input.choices?.[0] ?? 'label' }, confidence: 0.9 };
    case 'pii.detect':
      return { output: { spans: [] }, confidence: 0.99 };
    case 'text.translate':
      return { output: { text: `[${input.targetLanguage ?? 'en'}] ${input.text ?? ''}`.trim() } };
    case 'speech.text':
      return { output: { text: 'Transcript written by the stub engine.' } };
    default:
      return { output: { text: 'stub' } };
  }
}

function toAvailability(v: AvailabilityState | EngineAvailability): EngineAvailability {
  return typeof v === 'string' ? { state: v } : v;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The run was aborted.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The run was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createStubEngine(opts: StubEngineOptions = {}): StubEngine {
  const calls: { availability: EngineCheckRequest[]; run: EngineRunRequest[] } = {
    availability: [],
    run: [],
  };
  const tasks = opts.tasks ? new Set(opts.tasks) : undefined;
  const modelKeys = opts.modelKeys ? new Set(opts.modelKeys) : undefined;
  return {
    engineClass: opts.engineClass ?? 'stub',
    id: opts.id ?? 'stub',
    calls,
    supports(task, modelKey) {
      return (!tasks || tasks.has(task)) && (!modelKeys || modelKeys.has(modelKey));
    },
    async availability(req) {
      calls.availability.push(req);
      const a = opts.availability ?? 'available';
      return typeof a === 'function' ? a(req) : toAvailability(a);
    },
    async run(req) {
      calls.run.push(req);
      if (opts.delayMs !== undefined && opts.delayMs > 0) await wait(opts.delayMs, req.signal);
      const result = opts.respond ? await opts.respond(req) : stubAnswer(req);
      return opts.observedVersion !== undefined && result.observedVersion === undefined
        ? { ...result, observedVersion: opts.observedVersion }
        : result;
    },
  };
}
