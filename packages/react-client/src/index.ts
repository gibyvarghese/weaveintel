// SPDX-License-Identifier: MIT
/**
 * @weaveintel/react-client
 *
 * Ergonomic React hooks over `@weaveintel/client`. `useRun` wraps the
 * framework-agnostic `createRunSession` controller with `useSyncExternalStore`
 * so a component re-renders on every (throttle-coalesced) view-model change,
 * while the imperative affordances (`start` / `stop` / `regenerate` / HITL
 * `approve`·`reject`) are stable callbacks safe to pass as props.
 *
 * This mirrors the convention already used by clients/mobile's
 * `useChatSession` — the per-run state machine lives in the shared package; the
 * hook is a thin, host-specific binding.
 *
 * The host owns the `RunClient` (created once, e.g. via `createRunClient`) and
 * passes it in `options.client`. Pass a STABLE options object (memoize it) — the
 * session is constructed once on mount and disposed on unmount.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  createRunSession,
  type RunSession,
  type RunSessionOptions,
  type RunSessionState,
  type RunSessionStartInput,
} from '@weaveintel/client';

export type {
  RunSession,
  RunSessionOptions,
  RunSessionState,
  RunSessionStatus,
  RunSessionStartInput,
} from '@weaveintel/client';

/** The value returned by {@link useRun}: the live state plus stable actions. */
export interface UseRun extends RunSessionState {
  /** Start a new run. Resolves to the run id. Rejects if one is in progress. */
  start: (input?: RunSessionStartInput) => Promise<string>;
  /** Cancel the in-flight run and settle as `ready`. No-op when idle. */
  stop: () => Promise<void>;
  /** Re-run the last `start()` input as a fresh run. */
  regenerate: () => Promise<string>;
  /** Resolve a HITL approval part by task id. */
  approve: (taskId: string) => Promise<void>;
  /** Reject a HITL approval part by task id. */
  reject: (taskId: string) => Promise<void>;
  /** Post a raw client event into the running run. */
  sendEvent: (payload: Record<string, unknown>) => Promise<void>;
  /** Detach and clear back to `idle` (keeps last input for `regenerate`). */
  reset: () => void;
  /** `true` while the run is producing output. */
  isStreaming: boolean;
  /** `true` while a run is submitted or streaming (the composer's busy state). */
  isLoading: boolean;
  /** Escape hatch to the underlying controller (e.g. `done()`). */
  session: RunSession;
}

/**
 * Bind a {@link RunSession} to a React component.
 *
 * @example
 * const client = useMemo(() => createRunClient({ baseUrl: '' }), []);
 * const run = useRun({ client, throttleMs: 60 });
 * // run.status, run.model.fullText, run.start({ input: { text } }), run.stop()
 */
export function useRun(options: RunSessionOptions): UseRun {
  const sessionRef = useRef<RunSession | null>(null);
  if (sessionRef.current === null) {
    // Lazy init (like useState's initializer) — constructs exactly once.
    sessionRef.current = createRunSession(options);
  }
  const session = sessionRef.current;

  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);

  // Dispose the controller (detach stream + drop subscribers) on unmount.
  useEffect(() => () => session.dispose(), [session]);

  const start = useCallback((input?: RunSessionStartInput) => session.start(input), [session]);
  const stop = useCallback(() => session.stop(), [session]);
  const regenerate = useCallback(() => session.regenerate(), [session]);
  const approve = useCallback((taskId: string) => session.approve(taskId), [session]);
  const reject = useCallback((taskId: string) => session.reject(taskId), [session]);
  const sendEvent = useCallback((payload: Record<string, unknown>) => session.sendEvent(payload), [session]);
  const reset = useCallback(() => session.reset(), [session]);

  return {
    ...state,
    start,
    stop,
    regenerate,
    approve,
    reject,
    sendEvent,
    reset,
    isStreaming: state.status === 'streaming',
    isLoading: state.status === 'submitted' || state.status === 'streaming',
    session,
  };
}
