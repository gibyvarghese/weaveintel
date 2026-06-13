/**
 * @geneweave/mobile logic layer — the pure, framework-agnostic "brain" of the
 * geneWeave mobile app.
 *
 * Everything exported here is testable in Node with no React / React Native /
 * expo present: env + host normalization, host reachability validation, the
 * secure per-tenant token/host persistence, the biometric-gate decision logic,
 * the auth controller + observable store, deep-link parsing, and theme
 * resolution. The native view layer (`src/native/`) and Expo Router screens
 * (`app/`) are thin consumers of these modules.
 */

/** Schema version of the mobile logic surface. */
export const MOBILE_LIB_SCHEMA_VERSION = 1 as const;

// Config / environment
export {
  readMobileEnv,
  normalizeHost,
  tryNormalizeHost,
  InvalidHostError,
  type MobileEnv,
} from './config/env.js';

// Host validation + production probe
export { validateHost, type HostProbe, type HostValidation } from './auth/host.js';
export { createCatalogHostProbe } from './auth/host-probe.js';

// Secure per-tenant persistence
export {
  tenantNamespace,
  createTenantTokenStore,
  getStoredHost,
  setStoredHost,
  getStoredTenant,
  setStoredTenant,
  getStoredBiometricEnabled,
  setStoredBiometricEnabled,
} from './auth/secure-token-store.js';

// Biometric gate
export {
  BIOMETRIC_RELOCK_MS,
  isGateActive,
  requiresUnlockOnColdStart,
  requiresUnlockOnForeground,
  type BiometricGateState,
} from './auth/biometric-gate.js';

// Auth store + controller
export { createAuthStore, type AuthState, type AuthStore, type AuthListener } from './auth/auth-store.js';
export {
  createAuthController,
  type AuthController,
  type AuthControllerOptions,
  type BiometricAuthenticator,
  type ClientFactory,
} from './auth/auth-controller.js';

// Navigation
export {
  DEEP_LINK_SCHEME,
  parseDeepLink,
  buildDeepLink,
  intentToRoute,
  type RouteIntent,
  type RouteTarget,
} from './navigation/deep-links.js';

// Theme resolution
export {
  resolveThemeName,
  resolveAppTheme,
  type ThemePreference,
  type SystemColorScheme,
  type ResolvedAppTheme,
} from './theme/tenant-theme.js';

// Chat session (M4)
export {
  CHAT_SESSION_SCHEMA_VERSION,
  DETACH_BACKGROUND_MS,
  isTerminalStatus,
  createChatSession,
  emptyChatSessionState,
  type ChatSession,
  type ChatSessionOptions,
  type ChatSessionState,
  type ChatSessionListener,
  type ChatPhase,
  type ChatEntry,
  type UserEntry,
  type AssistantEntry,
  type ChatRunClient,
} from './chat/chat-session.js';
export {
  messagesToEntries,
} from './chat/history.js';
export {
  parseMarkdown,
  parseInline,
  type MarkdownBlock,
  type InlineSpan,
} from './chat/markdown.js';

// SSE frame parsing (shared by the RN XHR stream transport)
export {
  createSseFrameParser,
  type SseFrameParser,
  type SseFrameParserOptions,
} from './net/sse-frames.js';

// Widget render specs (M5) — the pure brain behind the native widget surface.
export {
  buildWidgetSpec,
  WIDGET_RENDER_KINDS,
  SUPPORTED_SCHEMA_VERSION,
  type WidgetInput,
  type WidgetViewSpec,
  type WidgetRenderKind,
  type ActionSpec,
  type FormFieldSpec,
} from './widgets/widget-spec.js';

// Conversation list logic (M6) — the pure brain behind the Chats tab.
export {
  isActiveRunStatus,
  filterConversations,
  sectionizeConversations,
  buildConversationView,
  applyConversationPatch,
  countConversations,
  formatRelativeTimestamp,
  type ConversationSection,
  type ConversationSectionId,
  type ConversationChip,
  type ConversationQuery,
  type ConversationFlagPatch,
} from './conversations/conversation-list.js';
export { widgetFixtures, type WidgetFixture } from './widgets/widget-fixtures.js';

// Actions tab logic (M7) — the pure brain behind Approvals / Tasks / Reminders.
export {
  isOpenTask,
  isApproval,
  isDueToday,
  buildApprovals,
  buildActionItems,
  buildReminders,
  reminderFireAt,
  reminderIsRecurring,
  reminderLabel,
  reminderIsEnabled,
  countActionsBadge,
  removeTask,
  removeReminder,
  applyReminderReschedule,
  snoozeTargetIso,
  formatDueLabel,
  taskConversationId,
  reminderConversationId,
  type ActionSegment,
  type SnoozeChoice,
} from './actions/action-list.js';
