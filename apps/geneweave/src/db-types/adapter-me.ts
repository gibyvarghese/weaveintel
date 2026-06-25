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
