/**
 * schemas.ts — the verified geneWeave `/api/me` surface as zod contracts.
 *
 * Each schema mirrors a response shape served by `apps/geneweave/src/routes/*`
 * (auth.ts, me.ts, me-memories.ts, me-conversations.ts). Records that the
 * server may extend over time use `.passthrough()` so the client tolerates
 * additive changes (forward-compatible) while still validating the fields it
 * depends on. A response that violates the *required* shape surfaces as a
 * {@link ResponseShapeError} rather than being silently coerced.
 *
 * No React / React Native imports — pure zod + inferred types.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Auth — POST /api/auth/token, GET /api/auth/me
// ---------------------------------------------------------------------------

export const MeUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable().optional(),
    persona: z.string().nullable().optional(),
    tenantId: z.string().nullable().optional(),
  })
  .passthrough();
export type MeUser = z.infer<typeof MeUserSchema>;

export const AuthSessionSchema = z
  .object({
    token: z.string(),
    csrfToken: z.string(),
    expiresAt: z.string(),
    user: MeUserSchema,
    permissions: z.array(z.string()).default([]),
  })
  .passthrough();
export type AuthSession = z.infer<typeof AuthSessionSchema>;

// ---------------------------------------------------------------------------
// Runs — POST/GET /api/me/runs, /:id, /cancel, /events
// ---------------------------------------------------------------------------

export const RunStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunRecordSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    tenant_id: z.string().nullable().optional(),
    status: RunStatusSchema,
    surface: z.string().nullable().optional(),
    metadata: z.string().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const RunListSchema = z.object({ runs: z.array(RunRecordSchema) });

/** A single resumable run event, as delivered over SSE and replayed on attach. */
export const RunEventEnvelopeSchema = z
  .object({
    runId: z.string(),
    sequence: z.number(),
    kind: z.string(),
    payload: z.record(z.string(), z.unknown()).default({}),
    timestamp: z.number().optional(),
  })
  .passthrough();
export type RunEventEnvelope = z.infer<typeof RunEventEnvelopeSchema>;

export const PostEventResultSchema = z.object({ sequence: z.number() });
export type PostEventResult = z.infer<typeof PostEventResultSchema>;

export const CancelRunResultSchema = z.object({ status: RunStatusSchema });
export type CancelRunResult = z.infer<typeof CancelRunResultSchema>;

// ---------------------------------------------------------------------------
// Catalog — GET /api/me/catalog?surface=mobile
// ---------------------------------------------------------------------------

export const StarterPromptSchema = z
  .object({ id: z.string(), label: z.string(), promptText: z.string() })
  .passthrough();
export type StarterPrompt = z.infer<typeof StarterPromptSchema>;

export const CatalogSchema = z
  .object({
    surfaceId: z.string(),
    resolvedAt: z.union([z.string(), z.number()]).optional(),
    entries: z.array(z.record(z.string(), z.unknown())).default([]),
    starterPrompts: z.array(StarterPromptSchema).default([]),
  })
  .passthrough();
export type Catalog = z.infer<typeof CatalogSchema>;

// ---------------------------------------------------------------------------
// Tenant theme — GET /api/me/theme
// Per-tenant design tokens (colors / font families / corner radii). Lenient by
// design: the brand token names are open maps, and a missing/cleared theme is
// `null`. WCAG-AA enforcement happens client-side in @geneweave/tokens.
// ---------------------------------------------------------------------------

export const TenantThemeTokensSchema = z
  .object({
    colors: z.record(z.string(), z.string()).optional(),
    typography: z.object({ families: z.record(z.string(), z.string()).optional() }).passthrough().optional(),
    radii: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();
export type TenantThemeTokens = z.infer<typeof TenantThemeTokensSchema>;

export const TenantThemeResponseSchema = z
  .object({ theme: TenantThemeTokensSchema.nullable().default(null) })
  .passthrough();

// ---------------------------------------------------------------------------
// Tasks — GET/POST /api/me/tasks, complete, cancel
// ---------------------------------------------------------------------------

export const TaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    assignee: z.string().optional(),
    description: z.string().nullable().optional(),
    dueAt: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    completedAt: z.string().nullable().optional(),
    provenance: z.record(z.string(), z.unknown()).optional(),
    data: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();
export type Task = z.infer<typeof TaskSchema>;

export const TaskListSchema = z.object({ tasks: z.array(TaskSchema) });

// ---------------------------------------------------------------------------
// Notification actions — POST /api/me/notifications/actions
// ---------------------------------------------------------------------------

export const NotificationActionSchema = z.enum(['approve', 'deny']);
export type NotificationAction = z.infer<typeof NotificationActionSchema>;

/**
 * Result of resolving a notification action. Idempotent: a task already in a
 * terminal state returns `{ alreadyResolved: true, status }`; a fresh
 * resolution returns `{ resolved: true, status }`.
 */
export const NotificationActionResultSchema = z
  .object({
    resolved: z.boolean().optional(),
    alreadyResolved: z.boolean().optional(),
    status: z.string(),
  })
  .passthrough();
export type NotificationActionResult = z.infer<typeof NotificationActionResultSchema>;

// ---------------------------------------------------------------------------
// Reminders — GET/POST /api/me/reminders, reschedule, delete
// ---------------------------------------------------------------------------

export const ReminderSchema = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    ownerPrincipalId: z.string().optional(),
    enabled: z.boolean().optional(),
    source: z
      .object({
        kind: z.string().optional(),
        config: z
          .object({ fireAt: z.string().optional(), rrule: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    metadata: z
      .object({ oneShot: z.boolean().optional(), label: z.string().optional() })
      .passthrough()
      .optional(),
    provenance: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();
export type Reminder = z.infer<typeof ReminderSchema>;

export const ReminderListSchema = z.object({ reminders: z.array(ReminderSchema) });

// ---------------------------------------------------------------------------
// Devices — POST/DELETE /api/me/devices
// ---------------------------------------------------------------------------

export const DeviceChannelSchema = z.enum(['apns', 'fcm']);
export type DeviceChannel = z.infer<typeof DeviceChannelSchema>;

export const RegisterDeviceResultSchema = z.object({ registered: z.boolean() }).passthrough();
export type RegisterDeviceResult = z.infer<typeof RegisterDeviceResultSchema>;

// ---------------------------------------------------------------------------
// Notification preferences — GET/PUT /api/me/notification-preferences
// ---------------------------------------------------------------------------

export const NotificationPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    categories: z.array(z.string()).default([]),
    quietHours: z.string().nullable().default(null),
  })
  .passthrough();
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

// ---------------------------------------------------------------------------
// Memories — GET/POST/PATCH/DELETE /api/me/memories
// ---------------------------------------------------------------------------

export const MemoryItemSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    kind: z.string(),
    createdAt: z.string().optional(),
    provenance: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const MemoriesSchema = z
  .object({
    memories: z.object({
      semantic: z.array(MemoryItemSchema).default([]),
      entity: z.array(MemoryItemSchema).default([]),
      'user-authored': z.array(MemoryItemSchema).default([]),
    }),
    counts: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();
export type Memories = z.infer<typeof MemoriesSchema>;

export const CreatedMemorySchema = z
  .object({
    id: z.string(),
    content: z.string(),
    kind: z.string(),
    createdAt: z.string().optional(),
    correctedFrom: z.string().optional(),
  })
  .passthrough();
export type CreatedMemory = z.infer<typeof CreatedMemorySchema>;

// ---------------------------------------------------------------------------
// Conversations (SP2) — GET /api/me/conversations, PATCH /:id
// ---------------------------------------------------------------------------

export const ConversationFilterSchema = z.enum(['active', 'archived', 'pinned', 'all']);
export type ConversationFilter = z.infer<typeof ConversationFilterSchema>;

export const ConversationSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    snippet: z.string().nullable(),
    mode: z.string().nullable().optional(),
    updatedAt: z.string(),
    runStatus: z.string().nullable(),
    pinned: z.boolean(),
    archived: z.boolean(),
    hasPendingAction: z.boolean(),
    participants: z.array(z.string()).default([]),
    unread: z.boolean(),
  })
  .passthrough();
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationListSchema = z.object({ conversations: z.array(ConversationSchema) });
export const ConversationPatchResultSchema = z.object({ conversation: ConversationSchema });

// A single transcript message (GET /api/me/conversations/:id/messages). Only
// user/assistant turns are surfaced; role is left open for forward-compat.
export const ConversationMessageSchema = z
  .object({
    id: z.string(),
    role: z.string(),
    content: z.string(),
    createdAt: z.string(),
  })
  .passthrough();
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationMessagesSchema = z.object({ messages: z.array(ConversationMessageSchema) });
