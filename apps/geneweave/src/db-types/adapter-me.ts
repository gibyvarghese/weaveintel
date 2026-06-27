/**
 * DB adapter — /api/me/ user-scope tables
 */
import type { TemporalReminderRow } from './core.js';

export interface UserRunRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  surface: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRunEventRow {
  id: string;
  run_id: string;
  sequence: number;
  kind: string;
  payload: string;
  created_at: string;
}

/** m94 (Collaboration Phase 1) — a current presence row for a run participant. */
export interface RunPresenceRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  user_id: string;
  display_name: string;
  presence: string;
  peer_type: string;
  color: string | null;
  cursor_json: string | null;
  last_heartbeat_at: number;
  expires_at: number;
  created_at: string;
}

/** m94 — single-row collaboration config (presence cadence, DB-driven). */
export interface CollaborationConfigRow {
  id: string;
  enabled: number;
  presence_heartbeat_ms: number;
  presence_ttl_ms: number;
  presence_sweep_ms: number;
  max_participants_per_run: number;
  show_agent_presence: number;
  updated_at: string;
}

/** m95 (Collaboration Phase 2) — a shared session over a run. */
export interface SharedSessionRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  owner_id: string;
  status: 'live' | 'ended';
  max_participants: number;
  created_at: number;
  ended_at: number | null;
}

/** m95 — a durable membership row (who may access the run + their role). */
export interface SessionParticipantRow {
  id: string;
  session_id: string;
  tenant_id: string | null;
  user_id: string;
  role: 'owner' | 'collaborator' | 'viewer';
  joined_at: number;
  invited_via_token_id: string | null;
}

/** m95 — an invite-link token (SHA-256 hash stored; plaintext shown once). */
export interface ShareTokenRow {
  id: string;
  session_id: string;
  tenant_id: string | null;
  role: 'owner' | 'collaborator' | 'viewer';
  token_hash: string;
  token_prefix: string;
  max_uses: number | null;
  uses: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
}

/** m96 (Collaboration Phase 3) — a durable run subscription ("notify me"). */
export interface RunSubscriptionRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  user_id: string;
  /** JSON array of channel ids, e.g. `["inapp","webhook"]`. */
  channels: string;
  created_at: number;
}

/** m96 — a row in the per-user in-app notification feed (the bell inbox). */
export interface NotificationFeedRow {
  id: string;
  tenant_id: string | null;
  principal_id: string;
  category: string;
  title: string;
  body: string | null;
  deep_link: string | null;
  priority: 'low' | 'normal' | 'high';
  dedupe_key: string | null;
  created_at: number;
  read_at: number | null;
}

/** m96 — a transactional-outbox delivery job (crash-safe at-least-once). */
export interface NotificationOutboxRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  user_id: string;
  channels: string;          // JSON array
  payload: string;           // JSON NotificationMessage
  idempotency_key: string;   // webhook-id + feed dedupe key
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  lease_until: number | null;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

/** m96 — a registered outbound webhook endpoint (referenced by id, never inline). */
export interface WebhookEndpointRow {
  id: string;
  tenant_id: string | null;
  user_id: string;
  url: string;
  signing_secret: string;
  enabled: number;
  created_at: number;
  revoked_at: number | null;
}

/** m97 (Collaboration Phase 4) — a threaded, part-anchored review comment. */
export interface RunCommentRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  thread_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  body_html: string;
  mentions_json: string;
  anchor_part_id: string;
  anchor_seq: number;
  anchor_range_json: string | null;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  deleted_by: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
}

/** m97 — a structured human-feedback score (the evals bridge). */
export interface RunAnnotationRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  part_id: string;
  author_id: string;
  name: string;
  data_type: 'numeric' | 'categorical' | 'boolean' | 'text';
  value: number | null;
  string_value: string | null;
  comment: string | null;
  source: 'human' | 'llm_judge' | 'eval_code' | 'api' | 'end_user';
  created_at: number;
}

/** m97 — a public read-only share token (capability URL, hashed at rest). */
export interface RunPublicShareRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  token_hash: string;
  token_prefix: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

/** m98 (Collaboration Phase 5) — a durable unified-handoff record. */
export interface SessionHandoffRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  scope: 'user_to_user' | 'agent_to_human' | 'agent_to_agent';
  from_actor_type: 'user' | 'agent' | 'role';
  from_actor_id: string;
  to_actor_type: 'user' | 'agent' | 'role';
  to_actor_id: string;
  state: string;
  reason: string;
  briefing_json: string | null;
  rejection_reason: string | null;
  hand_back_briefing_json: string | null;
  depth: number;
  parent_handoff_id: string | null;
  reference_task_ids_json: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  expires_at: number | null;
}

/** m98 — one append-only handoff audit event (a single transition). */
export interface HandoffEventRow {
  id: string;
  handoff_id: string;
  at: number;
  actor_id: string;
  from_state: string | null;
  to_state: string;
  note: string | null;
}

/** m99 (Collaboration Phase 7) — a CRDT co-editing document (the canonical replica). */
export interface CoeditDocRow {
  id: string;
  run_id: string;
  tenant_id: string | null;
  owner_id: string;
  title: string | null;
  snapshot_json: string;       // full RGA state
  state_vector_json: string;   // max op counter per site
  agent_written: number;       // chars the agent peer has streamed (idempotency)
  created_at: number;
  updated_at: number;
}

/** m99 — one append-only co-edit op (keyed by author site + counter). */
export interface CoeditOpRow {
  id: string;
  doc_id: string;
  op_site: string;
  op_counter: number;
  op_json: string;
  created_at: number;
}

// ── weaveNotes Phase 2 — collaborative NOTE co-editing (m100) ──────────────────

/** m100 — the canonical `BlockDoc` CRDT replica for one co-edited note. */
export interface NoteCoeditDocRow {
  id: string;
  note_id: string;
  tenant_id: string | null;
  owner_id: string;
  snapshot_json: string;       // full BlockDoc state (elements + LWW attrs + marks)
  state_vector_json: string;   // max op counter per author site
  created_at: number;
  updated_at: number;
}

/** m100 — one append-only block co-edit op (keyed by author site + counter). */
export interface NoteCoeditOpRow {
  id: string;
  doc_id: string;
  op_site: string;
  op_counter: number;
  op_json: string;
  created_at: number;
}

/** m100 — durable note membership (the owner is implicit; only other people get rows). */
export interface NoteShareRow {
  id: string;
  note_id: string;
  tenant_id: string | null;
  owner_id: string;
  user_id: string;
  role: 'collaborator' | 'viewer';
  joined_at: number;
  invited_via_token_id: string | null;
}

/** m100 — a note invite link (256-bit token, SHA-256-hashed at rest). */
export interface NoteShareTokenRow {
  id: string;
  note_id: string;
  tenant_id: string | null;
  owner_id: string;
  role: 'collaborator' | 'viewer';
  token_hash: string;
  token_prefix: string;
  max_uses: number | null;
  uses: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
}

/** m101 — one AI co-author SUGGESTION (track-changes: staged block ops a human accepts/rejects). */
export interface NoteSuggestionRow {
  id: string;
  note_id: string;
  doc_id: string;
  tenant_id: string | null;
  author_kind: 'agent' | 'user';
  author_id: string;
  author_site: string;
  action: 'continue' | 'rewrite' | 'summarize' | 'ask' | 'note_edit' | 'ai_block'
    | 'apply_highlight' | 'apply_text_color' | 'colorize_semantic'
    | 'create_diagram' | 'draw_ink' | 'recolor_ink'
    | 'create_illustration' | 'generate_image';
  status: 'pending' | 'accepted' | 'rejected';
  ops_json: string;
  preview_text: string;
  anchor_json: string | null;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

// ── weaveNotes Phase 5 — notes knowledge graph (m102) ─────────────────────────

export interface NoteEntityRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  name: string;
  name_key: string;
  type: string;
  created_at: number;
}
export interface NoteRelationRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  subject: string;
  predicate: string;
  object: string;
  created_at: number;
}
export interface NoteEmbeddingRow {
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  dim: number;
  embedding_json: string;
  content_hash: string;
  title: string | null;
  updated_at: number;
}

/** m103 — weaveNotes Phase 8: one embedding per chat RUN output (workspace RAG over runs). */
export interface RunEmbeddingRow {
  run_id: string;
  user_id: string;
  tenant_id: string | null;
  dim: number;
  embedding_json: string;
  content_hash: string;
  title: string | null;
  content: string | null;
  updated_at: number;
}

/** m103 — weaveNotes Phase 8: a per-note version snapshot (history + restore). */
export interface NoteVersionRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  title: string;
  doc_json: string;
  label: string | null;
  reason: string;
  word_count: number;
  created_by: string;
  created_at: number;
}

/** m103 — weaveNotes Phase 8: a threaded, block-anchored review comment on a note. */
export interface NoteCommentRow {
  id: string;
  note_id: string;
  tenant_id: string | null;
  thread_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  body_html: string;
  mentions_json: string;
  anchor_block_id: string;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  deleted_by: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
}

/** m103 — weaveNotes Phase 8: a synced block (transclusion) mirroring another note's block. */
export interface NoteSyncedBlockRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  source_note_id: string;
  source_block_id: string;
  created_at: number;
}

/** m104 — weaveNotes Phase 0: the single-row capability config (Builder-editable). */
export interface WeaveNotesSettingsRow {
  id: string;
  default_theme: string;
  agency_color_enabled: number;
  ai_suggestions_require_approval: number;
  activity_tracking_enabled: number;
  activity_retention_days: number;
  max_ai_tokens_per_edit: number;
  local_model_for_sensitive: number;
  /** weaveNotes Phase 3: show live collaborator cursors (0/1). */
  live_cursors_enabled: number;
  /** weaveNotes Phase 3: show the AI as a live participant while it edits (0/1). */
  ai_presence_enabled: number;
  /** weaveNotes Phase 4 creative modes (0/1) + the image model. */
  diagrams_enabled: number;
  ink_enabled: number;
  illustration_enabled: number;
  image_generation_enabled: number;
  image_model: string;
  /** weaveNotes Phase 5: flashcards + spaced repetition. */
  flashcards_enabled: number;
  daily_new_card_limit: number;
  /** weaveNotes Phase 7: mobile offline editing + ink + how many notes to cache on-device. */
  mobile_offline_enabled: number;
  mobile_ink_enabled: number;
  mobile_offline_note_limit: number;
  enabled_ai_tools: string;
  updated_at: string;
}

/** m104 — weaveNotes Phase 0: a "what changed" activity log row. */
export interface NoteActivityRow {
  id: string;
  note_id: string;
  user_id: string;
  tenant_id: string | null;
  action: string;
  actor: string;
  summary: string | null;
  detail_json: string | null;
  created_at: string;
}

export interface UserDeviceRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  channel: 'web-push' | 'apns' | 'fcm';
  token: string;
  label: string | null;
  created_at: string;
}

export interface NotificationPrefsRow {
  id: string;
  user_id: string;
  enabled: number;
  categories: string;
  quiet_hours: string | null;
  timezone: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModeLabel {
  id: string;
  surface_id: string;
  mode_key: string;
  label: string;
  description: string | null;
  icon: string | null;
  is_default: number;
  sort_order: number;
  enabled: number;
  metadata: string | null;
  created_at: string;
}

export interface StarterPrompt {
  id: string;
  surface_id: string;
  label: string;
  prompt_text: string;
  sort_order: number;
  enabled: number;
  metadata: string | null;
  created_at: string;
}

export interface IMeStore {
  // Runs
  createUserRun(run: Pick<UserRunRow, 'id' | 'user_id' | 'status'> & {
    tenant_id?: string; surface?: string; metadata?: string;
  }): Promise<void>;
  getUserRun(id: string, userId: string): Promise<UserRunRow | null>;
  /** Owner-agnostic run lookup (Phase 3 notification outbox). NOT an access path. */
  getUserRunById(id: string): Promise<UserRunRow | null>;
  listUserRuns(userId: string, filter?: {
    status?: UserRunRow['status']; limit?: number; offset?: number;
  }): Promise<UserRunRow[]>;
  updateUserRunStatus(id: string, userId: string, status: UserRunRow['status']): Promise<void>;

  // Run events
  appendUserRunEvent(event: Pick<UserRunEventRow, 'id' | 'run_id' | 'sequence' | 'kind' | 'payload'>): Promise<void>;
  listUserRunEvents(runId: string, afterSequence?: number): Promise<UserRunEventRow[]>;
  /** Per-run journal purge (backs the core RunJournal port's `purgeRun`). */
  deleteUserRunEvents(runId: string): Promise<number>;
  // ── Presence (m94, Collaboration Phase 1) ─────────────────────────────────
  upsertRunPresence(row: Omit<RunPresenceRow, 'created_at' | 'tenant_id' | 'color' | 'cursor_json'> & { tenant_id?: string | null; color?: string | null; cursor_json?: string | null }): Promise<void>;
  listActiveRunPresence(runId: string, now: number): Promise<RunPresenceRow[]>;
  deleteRunPresence(runId: string, userId: string): Promise<number>;
  deleteExpiredRunPresence(now: number): Promise<Array<{ run_id: string; tenant_id: string | null }>>;
  getCollaborationConfig(): Promise<CollaborationConfigRow | null>;
  // ── Shared sessions + invite links (m95, Collaboration Phase 2) ────────────
  createSharedSession(row: { id: string; run_id: string; tenant_id?: string | null; owner_id: string; max_participants: number; created_at: number }): Promise<void>;
  getSharedSessionById(id: string): Promise<SharedSessionRow | null>;
  getSharedSessionByRun(runId: string): Promise<SharedSessionRow | null>;
  endSharedSession(id: string, endedAt: number): Promise<void>;
  upsertSessionParticipant(row: { id: string; session_id: string; tenant_id?: string | null; user_id: string; role: string; joined_at: number; invited_via_token_id?: string | null }): Promise<void>;
  getSessionParticipant(sessionId: string, userId: string): Promise<SessionParticipantRow | null>;
  listSessionParticipants(sessionId: string): Promise<SessionParticipantRow[]>;
  deleteSessionParticipant(sessionId: string, userId: string): Promise<number>;
  createShareToken(row: { id: string; session_id: string; tenant_id?: string | null; role: string; token_hash: string; token_prefix: string; max_uses?: number | null; expires_at?: number | null; created_by: string; created_at: number }): Promise<void>;
  getShareTokenByHash(tokenHash: string): Promise<ShareTokenRow | null>;
  incrementShareTokenUses(id: string): Promise<void>;
  revokeShareToken(id: string, revokedAt: number): Promise<void>;
  // ── Durable subscriptions + notifications (m96, Collaboration Phase 3) ──────
  upsertRunSubscription(row: { id: string; run_id: string; tenant_id?: string | null; user_id: string; channels: string; created_at: number }): Promise<RunSubscriptionRow>;
  deleteRunSubscription(runId: string, userId: string): Promise<number>;
  getRunSubscription(runId: string, userId: string): Promise<RunSubscriptionRow | null>;
  listRunSubscribers(runId: string): Promise<RunSubscriptionRow[]>;
  listSubscriptionsForUser(userId: string): Promise<RunSubscriptionRow[]>;
  // Notification feed (in-app inbox)
  appendNotificationFeed(row: NotificationFeedRow): Promise<NotificationFeedRow>;
  listNotificationFeed(tenantId: string, principalId: string, opts?: { limit?: number; unreadOnly?: boolean }): Promise<NotificationFeedRow[]>;
  countUnreadNotificationFeed(tenantId: string, principalId: string): Promise<number>;
  markNotificationFeedRead(tenantId: string, principalId: string, id: string, now: number): Promise<boolean>;
  markAllNotificationFeedRead(tenantId: string, principalId: string, now: number): Promise<number>;
  // Transactional outbox (crash-safe delivery)
  enqueueNotificationOutbox(row: { id: string; run_id: string; tenant_id?: string | null; user_id: string; channels: string; payload: string; idempotency_key: string; next_attempt_at: number; created_at: number }): Promise<boolean>;
  /** Atomically claim up to `limit` due rows (status pending/failed, next_attempt_at<=now), leasing them to `sending` until `leaseUntil`. Also reclaims `sending` rows whose lease expired. */
  claimNotificationOutbox(now: number, leaseUntil: number, limit: number): Promise<NotificationOutboxRow[]>;
  markNotificationOutboxSent(id: string, sentAt: number): Promise<void>;
  rescheduleNotificationOutbox(id: string, nextAttemptAt: number, attempts: number, lastError: string, failed: boolean): Promise<void>;
  /** Run ids that already have an outbox row (so a reconciler doesn't double-enqueue). */
  hasNotificationOutboxForRun(runId: string): Promise<boolean>;
  /** Terminal runs that have at least one subscriber (the reconciler backfill scan). */
  listTerminalRunsWithSubscribers(limit: number): Promise<UserRunRow[]>;
  // ── Run comments + annotations + public share (m97, Collaboration Phase 4) ──
  createRunComment(row: RunCommentRow): Promise<void>;
  getRunComment(id: string): Promise<RunCommentRow | null>;
  listRunComments(runId: string): Promise<RunCommentRow[]>;
  listRunCommentThread(threadId: string): Promise<RunCommentRow[]>;
  updateRunCommentBody(id: string, body: string, bodyHtml: string, mentionsJson: string, editedAt: number, updatedAt: number): Promise<void>;
  softDeleteRunComment(id: string, deletedBy: string, deletedAt: number): Promise<void>;
  setRunThreadResolution(threadId: string, resolvedAt: number | null, resolvedBy: string | null, updatedAt: number): Promise<void>;
  createRunAnnotation(row: RunAnnotationRow): Promise<void>;
  getRunAnnotation(id: string): Promise<RunAnnotationRow | null>;
  listRunAnnotations(runId: string): Promise<RunAnnotationRow[]>;
  deleteRunAnnotation(id: string): Promise<number>;
  createRunPublicShare(row: { id: string; run_id: string; tenant_id?: string | null; token_hash: string; token_prefix: string; created_by: string; created_at: number; expires_at?: number | null }): Promise<void>;
  getRunPublicShareByHash(tokenHash: string): Promise<RunPublicShareRow | null>;
  listRunPublicShares(runId: string): Promise<RunPublicShareRow[]>;
  revokeRunPublicShare(id: string, runId: string, revokedAt: number): Promise<number>;
  // ── Unified handoff (m98, Collaboration Phase 5) ────────────────────────────
  insertSessionHandoff(row: SessionHandoffRow): Promise<void>;
  getSessionHandoff(id: string): Promise<SessionHandoffRow | null>;
  updateSessionHandoff(id: string, fields: Partial<Pick<SessionHandoffRow, 'state' | 'rejection_reason' | 'hand_back_briefing_json' | 'updated_at' | 'resolved_at'>>): Promise<void>;
  listSessionHandoffsForRun(runId: string): Promise<SessionHandoffRow[]>;
  listSessionHandoffsForActor(actorId: string): Promise<SessionHandoffRow[]>;
  listDueSessionHandoffs(now: number): Promise<SessionHandoffRow[]>;
  insertHandoffEvent(row: HandoffEventRow): Promise<void>;
  listHandoffEvents(handoffId: string): Promise<HandoffEventRow[]>;
  // ── CRDT co-editing (m99, Collaboration Phase 7) ────────────────────────────
  createCoeditDoc(row: { id: string; run_id: string; tenant_id?: string | null; owner_id: string; title?: string | null; snapshot_json: string; state_vector_json: string; created_at: number; updated_at: number }): Promise<boolean>;
  getCoeditDoc(id: string): Promise<CoeditDocRow | null>;
  getCoeditDocByRun(runId: string): Promise<CoeditDocRow | null>;
  updateCoeditDoc(id: string, fields: { snapshot_json: string; state_vector_json: string; agent_written: number; updated_at: number }): Promise<void>;
  appendCoeditOp(row: CoeditOpRow): Promise<boolean>;
  listCoeditOps(docId: string): Promise<CoeditOpRow[]>;
  // ── weaveNotes Phase 2 — collaborative NOTE co-editing (m100) ────────────────
  createNoteCoeditDoc(row: { id: string; note_id: string; tenant_id?: string | null; owner_id: string; snapshot_json: string; state_vector_json: string; created_at: number; updated_at: number }): Promise<boolean>;
  getNoteCoeditDoc(id: string): Promise<NoteCoeditDocRow | null>;
  getNoteCoeditDocByNote(noteId: string): Promise<NoteCoeditDocRow | null>;
  updateNoteCoeditDoc(id: string, fields: { snapshot_json: string; state_vector_json: string; updated_at: number }): Promise<void>;
  appendNoteCoeditOp(row: NoteCoeditOpRow): Promise<boolean>;
  listNoteCoeditOps(docId: string): Promise<NoteCoeditOpRow[]>;
  // Note sharing (membership + invite tokens)
  getNoteForOwner(noteId: string, ownerId: string): Promise<{ id: string; owner_user_id: string; tenant_id: string | null } | null>;
  getNoteShare(noteId: string, userId: string): Promise<NoteShareRow | null>;
  listNoteShares(noteId: string): Promise<NoteShareRow[]>;
  upsertNoteShare(row: NoteShareRow): Promise<void>;
  deleteNoteShare(noteId: string, userId: string): Promise<number>;
  createNoteShareToken(row: NoteShareTokenRow): Promise<void>;
  getNoteShareTokenByHash(hash: string): Promise<NoteShareTokenRow | null>;
  listNoteShareTokens(noteId: string): Promise<NoteShareTokenRow[]>;
  incrementNoteShareTokenUses(id: string): Promise<void>;
  revokeNoteShareToken(id: string, noteId: string, revokedAt: number): Promise<number>;
  // weaveNotes Phase 3 — AI co-author suggestions (track-changes)
  createNoteSuggestion(row: NoteSuggestionRow): Promise<void>;
  getNoteSuggestion(id: string): Promise<NoteSuggestionRow | null>;
  listNoteSuggestions(noteId: string, status?: 'pending' | 'accepted' | 'rejected'): Promise<NoteSuggestionRow[]>;
  resolveNoteSuggestion(id: string, status: 'accepted' | 'rejected', resolvedAt: number, resolvedBy: string): Promise<number>;
  // weaveNotes Phase 5 — notes knowledge graph (entities / relations / embeddings)
  replaceNoteEntities(noteId: string, rows: NoteEntityRow[]): Promise<void>;
  listNoteEntities(noteId: string): Promise<NoteEntityRow[]>;
  replaceNoteRelations(noteId: string, rows: NoteRelationRow[]): Promise<void>;
  listNoteRelations(noteId: string): Promise<NoteRelationRow[]>;
  upsertNoteEmbedding(row: NoteEmbeddingRow): Promise<void>;
  getNoteEmbedding(noteId: string): Promise<NoteEmbeddingRow | null>;
  listUserNoteEmbeddings(userId: string): Promise<NoteEmbeddingRow[]>;
  // weaveNotes Phase 8 — workspace RAG (run output embeddings)
  upsertRunEmbedding(row: RunEmbeddingRow): Promise<void>;
  getRunEmbedding(runId: string): Promise<RunEmbeddingRow | null>;
  listUserRunEmbeddings(userId: string): Promise<RunEmbeddingRow[]>;
  // weaveNotes Phase 8 — per-note version history
  createNoteVersion(row: NoteVersionRow): Promise<void>;
  listNoteVersions(noteId: string): Promise<NoteVersionRow[]>;
  getNoteVersion(id: string): Promise<NoteVersionRow | null>;
  // weaveNotes Phase 8 — block comments on notes
  createNoteComment(row: NoteCommentRow): Promise<void>;
  getNoteComment(id: string): Promise<NoteCommentRow | null>;
  listNoteComments(noteId: string): Promise<NoteCommentRow[]>;
  listNoteCommentThread(threadId: string): Promise<NoteCommentRow[]>;
  updateNoteCommentBody(id: string, body: string, bodyHtml: string, mentionsJson: string, editedAt: number, updatedAt: number): Promise<void>;
  softDeleteNoteComment(id: string, deletedBy: string, deletedAt: number): Promise<void>;
  setNoteThreadResolution(threadId: string, resolvedAt: number | null, resolvedBy: string | null, updatedAt: number): Promise<void>;
  // weaveNotes Phase 8 — synced blocks (transclusion)
  createNoteSyncedBlock(row: NoteSyncedBlockRow): Promise<void>;
  getNoteSyncedBlock(id: string): Promise<NoteSyncedBlockRow | null>;
  listNoteSyncedBlocks(noteId: string): Promise<NoteSyncedBlockRow[]>;
  deleteNoteSyncedBlock(id: string, noteId: string): Promise<void>;
  // weaveNotes Phase 0 — capability config + activity log
  getWeaveNotesSettings(): Promise<WeaveNotesSettingsRow | null>;
  updateWeaveNotesSettings(fields: Partial<Omit<WeaveNotesSettingsRow, 'id'>>): Promise<void>;
  recordNoteActivity(row: NoteActivityRow): Promise<void>;
  listNoteActivity(noteId: string, limit?: number): Promise<NoteActivityRow[]>;
  // Registered outbound webhook endpoints
  createWebhookEndpoint(row: { id: string; tenant_id?: string | null; user_id: string; url: string; signing_secret: string; created_at: number }): Promise<void>;
  listWebhookEndpoints(userId: string): Promise<WebhookEndpointRow[]>;
  revokeWebhookEndpoint(id: string, userId: string, revokedAt: number): Promise<number>;
  /**
   * Prune the run-event journal (Client Phase 0). Removes events for terminal
   * runs older than `olderThanHours`, and trims any run whose event count
   * exceeds `maxEventsPerRun` to its most recent `maxEventsPerRun` rows.
   * Returns the number of rows deleted. Driven by `run_stream_config`.
   */
  pruneUserRunEvents(opts: { olderThanHours: number; maxEventsPerRun: number }): Promise<number>;

  // Devices
  registerDevice(device: Pick<UserDeviceRow, 'id' | 'user_id' | 'channel' | 'token'> & {
    tenant_id?: string; label?: string;
  }): Promise<void>;
  removeDevice(userId: string, token: string): Promise<void>;
  getDeviceById(deviceId: string): Promise<UserDeviceRow | null>;
  listDevices(userId: string): Promise<UserDeviceRow[]>;

  // Notification preferences
  getNotificationPrefs(userId: string): Promise<NotificationPrefsRow | null>;
  upsertNotificationPrefs(userId: string, prefs: {
    id: string; enabled?: boolean; categories?: string[]; quiet_hours?: string | null; timezone?: string | null;
  }): Promise<void>;

  // Catalog support
  listModeLabels(surfaceId: string): Promise<ModeLabel[]>;
  listStarterPrompts(surfaceId: string): Promise<StarterPrompt[]>;

  // Catalog administration (operator CRUD; include disabled rows)
  adminListModeLabels(surfaceId?: string): Promise<ModeLabel[]>;
  getModeLabel(id: string): Promise<ModeLabel | null>;
  createModeLabel(row: Pick<ModeLabel, 'id' | 'surface_id' | 'mode_key' | 'label'> & {
    description?: string | null; icon?: string | null; is_default?: number; sort_order?: number; enabled?: number; metadata?: string | null;
  }): Promise<void>;
  updateModeLabel(id: string, patch: Partial<Pick<ModeLabel,
    'label' | 'mode_key' | 'description' | 'icon' | 'is_default' | 'sort_order' | 'enabled' | 'metadata'>>): Promise<void>;
  deleteModeLabel(id: string): Promise<void>;

  adminListStarterPrompts(surfaceId?: string): Promise<StarterPrompt[]>;
  getStarterPrompt(id: string): Promise<StarterPrompt | null>;
  createStarterPrompt(row: Pick<StarterPrompt, 'id' | 'surface_id' | 'label' | 'prompt_text'> & {
    sort_order?: number; enabled?: number; metadata?: string | null;
  }): Promise<void>;
  updateStarterPrompt(id: string, patch: Partial<Pick<StarterPrompt,
    'label' | 'prompt_text' | 'sort_order' | 'enabled' | 'metadata'>>): Promise<void>;
  deleteStarterPrompt(id: string): Promise<void>;

  // Temporal reminders — cross-chat user view (Actions tab)
  listTemporalRemindersByUserId(userId: string): Promise<TemporalReminderRow[]>;
  deleteTemporalReminderById(reminderId: string, userId: string): Promise<boolean>;
}
