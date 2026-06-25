/**
 * @geneweave/api-client — typed client for the geneWeave /api/me surface.
 *
 * Wraps an injectable transport with bearer-token + CSRF injection from a
 * pluggable {@link TokenStore}, and exposes zod-validated typed methods for the
 * verified mobile surface (auth, runs, catalog, tasks, reminders, memories,
 * devices, notification prefs/actions, conversations).
 *
 * Per-tenant: each {@link createGeneweaveClient} call is an independent
 * instance (host + token store + outbox storage are all injected; no
 * module-level singletons), so one device can run a client per tenant/host.
 *
 * No React or React Native imports — this package stays runtime-agnostic.
 */

import { z } from 'zod';

/** Schema version of the client surface; consumers pin against this. */
export const API_CLIENT_SCHEMA_VERSION = 1 as const;

/** Connection config for the client. */
export const HostConfigSchema = z.object({
  /** Base origin of the geneWeave server, e.g. `https://api.example.com`. */
  host: z.string().url(),
});
export type HostConfig = z.infer<typeof HostConfigSchema>;

// Errors
export {
  GeneweaveApiError,
  AuthExpiredError,
  ManagedByOrgError,
  ResponseShapeError,
} from './errors.js';

// Token storage
export {
  MemoryTokenStore,
  namespacedTokenStore,
  type AuthTokens,
  type TokenStore,
  type KeyValueStore,
} from './token-store.js';

// Transport seam
export {
  createHttpTransport,
  type GeneweaveTransport,
  type RawResponse,
  type StreamHandlers,
  type TransportRequest,
  type CreateHttpTransportOptions,
} from './http.js';

// Client
export {
  createGeneweaveClient,
  type GeneweaveClient,
  type CreateGeneweaveClientOptions,
  type AttachRunOptions,
  type AttachHandle,
  type ListRunsFilter,
  type ListConversationsFilter,
  // Agenda + Calendar (WC2-WC5)
  type AgendaItem,
  type AgendaCategory,
  // Notes (WC6-WC10)
  type NoteListItem,
  type NoteDoc,
} from './client.js';

// Run primitives re-exported from @weaveintel/client that appear in this
// package's public surface (outbox storage, view model, start input), so
// consumers configure the client without importing @weaveintel/client directly.
export {
  MemoryStorage,
  streamReducer,
  emptyRunViewModel,
  // Phase 5 — UX primitives: the framework-agnostic run-session controller and
  // the single SSE parser, surfaced so hosts (mobile, web-React via
  // @weaveintel/react-client) configure them without importing @weaveintel/client.
  createRunSession,
  RUN_SESSION_SCHEMA_VERSION,
  RunResumeExpiredError,
  parseSseStream,
  SseStallError,
  // Phase 6 — refresh-proof resume, run metrics, outbox v2.
  createRunCursorStore,
  isCursorResumable,
  createRunMetrics,
  createRunOutbox,
  type OutboxStorage,
  type RunOutbox,
  type OutboxFlushResult,
  type OutboxItem,
  type RunViewModel,
  type StreamItem,
  type ToolCallView,
  type StartRunInput,
  type RunSession,
  type RunSessionOptions,
  type RunSessionState,
  type RunSessionStatus,
  type RunSessionStartInput,
  type SseEvent,
  type RunCursor,
  type RunCursorStore,
  type RunMetrics,
  type RunMetricsSnapshot,
} from '@weaveintel/client';

// Surface schemas + inferred types
export * from './schemas.js';
