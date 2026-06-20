/**
 * Safe integer parser for query parameters.
 * Handles NaN, Infinity, floats, negatives — never lets a raw Number() reach SQLite.
 */
export function safePageInt(value: string | null | undefined, defaultVal: number, min = 0, max = 10_000): number {
  const n = parseInt(value ?? '', 10);
  return isFinite(n) ? Math.max(min, Math.min(max, n)) : defaultVal;
}

export { registerAuthRoutes } from './auth.js';
export { registerModelRoutes } from './model.js';
export { registerSettingsRoutes } from './settings.js';
export { registerTraceRoutes } from './traces.js';
export { registerChatRoutes } from './chat.js';
export { registerAdminWiringRoutes } from './admin-wiring.js';
export { registerA2ARoutes } from './a2a.js';
export { registerMemoryRoutes } from './memory.js';
export { registerLiveAgentRoutes } from './live-agents.js';
export { registerAdminLiveRunStreamRoute } from './admin-live-run-stream.js';
export { registerMeRoutes } from './me.js';
export { registerMeConversationsRoutes } from './me-conversations.js';
export { registerMeMemoryRoutes } from './me-memories.js';
export { registerMeAgendaRoutes } from './me-agenda.js';
export { registerMeNotesRoutes } from './me-notes.js';
export { registerMeComplianceRoutes } from './me-compliance.js';
export { registerVoiceRoutes } from './voice.js';
