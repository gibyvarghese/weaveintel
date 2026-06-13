/**
 * use-chat-session.ts — binds the pure {@link createChatSession} controller to
 * React + React Native.
 *
 * Device-gated (imports `react` / `react-native`). It (1) builds exactly one
 * session for the active per-tenant client, (2) mirrors its observable store
 * with `useSyncExternalStore` so the screen stays declarative, (3) forwards OS
 * app-state transitions so the 20s background-detach window is enforced,
 * (4) loads the surface catalog (options + starter prompts) once, and (5) holds
 * the current option selection (mode / model / agent / skill) and stamps it onto
 * every run's metadata — so per-tenant model/token resolution happens
 * server-side from a DB-driven, RBAC-filtered hint. All chat decision logic
 * lives in `src/lib` — this hook holds none of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { Catalog } from '@geneweave/api-client';
import { createChatSession, type ChatSession, type ChatSessionState } from '../../lib';
import { useClient } from '../providers/auth-provider';

/** Surface id sent on every run and used to resolve the catalog. */
const SURFACE = 'mobile';

let idCounter = 0;
/** A locally-unique, sortable-ish id for entries and idempotency keys. */
function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface UseChatSession {
  state: ChatSessionState;
  session: ChatSession;
  /** The resolved surface catalog (options + starter prompts), or null while loading. */
  catalog: Catalog | null;
  /** Current option selection keyed by catalog kind (mode/model/agent/skill). */
  selectedOptions: Record<string, string>;
  /** Select (or toggle off) a catalog option for a kind. */
  setOption: (kind: string, id: string) => void;
}

export interface UseChatSessionOptions {
  /**
   * Resume an existing server-side conversation. When provided, runs target this
   * chat id so new turns append to that conversation. NOTE (M6): this rebinds the
   * session to the existing chat but does not hydrate prior messages into the
   * transcript — full history replay + live re-attach is tracked separately.
   */
  conversationId?: string;
}

export function useChatSession(options: UseChatSessionOptions = {}): UseChatSession {
  const client = useClient();
  const resumeId = options.conversationId;

  // The current option selection. A ref mirrors it so the session's
  // `runMetadata` closure (created once) always reads the latest selection.
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const selectionRef = useRef(selectedOptions);
  selectionRef.current = selectedOptions;

  // One session per client instance (i.e. per tenant/host), rebuilt when the
  // composition root hands us a different client OR a different conversation to
  // resume.
  const sessionRef = useRef<{ client: typeof client; conversationId: string; session: ChatSession } | null>(null);
  const needsRebuild =
    !sessionRef.current ||
    sessionRef.current.client !== client ||
    (resumeId !== undefined && resumeId !== sessionRef.current.conversationId);
  if (needsRebuild) {
    sessionRef.current?.session.dispose();
    // A stable conversation token for this session lifetime, so multi-turn
    // history resolves to the same server-side chat across runs. When resuming,
    // adopt the caller-supplied id instead of minting a fresh one.
    const conversationId = resumeId ?? makeId('chat');
    sessionRef.current = {
      client,
      conversationId,
      session: createChatSession({
        client,
        surface: SURFACE,
        idempotencyKey: () => makeId('idem'),
        newId: () => makeId('e'),
        runMetadata: () => {
          const sel = selectionRef.current;
          return Object.keys(sel).length > 0
            ? { chatId: conversationId, options: sel }
            : { chatId: conversationId };
        },
      }),
    };
  }
  const session = sessionRef.current!.session;

  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);

  // Forward OS app-state transitions for the background-detach window.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') session.onForeground();
      else if (next === 'background' || next === 'inactive') session.onBackground();
    });
    return () => sub.remove();
  }, [session]);

  // Dispose the session when the client (tenant) goes away for good.
  useEffect(() => () => session.dispose(), [session]);

  // Load the surface catalog once per client.
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    setSelectedOptions({});
    client
      .getCatalog(SURFACE)
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => {
        // Graceful: the catalog is optional — chat works without it.
        if (!cancelled) setCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const setOption = useCallback((kind: string, id: string) => {
    setSelectedOptions((prev) => (prev[kind] === id ? omit(prev, kind) : { ...prev, [kind]: id }));
  }, []);

  return useMemo(
    () => ({ state, session, catalog, selectedOptions, setOption }),
    [state, session, catalog, selectedOptions, setOption],
  );
}

function omit(obj: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _drop, ...rest } = obj;
  return rest;
}
