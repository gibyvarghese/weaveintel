// SPDX-License-Identifier: MIT

// ── Client + bus ───────────────────────────────────────────────────────────────
export { weaveA2AClient, weaveA2ABus } from './a2a.js';

// ── Task store (Phase 3) ───────────────────────────────────────────────────────
export {
  createInMemoryA2ATaskStore,
  createDurableA2ATaskStore,
  isTerminalA2AState,
  type A2ATaskStore,
  type A2ATaskStorePatch,
} from './task-store.js';

export {
  createSqliteA2ATaskStore,
  A2A_TASKS_DDL,
  type SqliteDb,
  type SqliteStatement,
} from './task-store-sqlite.js';

// ── Agent-as-server adapter ────────────────────────────────────────────────────
export { weaveAgentAsA2AServer, type AgentA2AServerOptions } from './agent-server.js';

// ── JSON-RPC 2.0 server dispatcher (Phase 2) ───────────────────────────────────
export {
  createA2ADispatcher,
  weaveA2AServer,
  streamToSse,
  eventToSse,
  SSE_KEEPALIVE,
  type A2ADispatchRequest,
  type A2ADispatchResult,
} from './a2a-server.js';

// ── JSON-RPC 2.0 codec ─────────────────────────────────────────────────────────
export {
  A2A_METHODS,
  A2A_ERROR_CODES,
  A2AJsonRpcError,
  makeRpcRequest,
  makeRpcSuccess,
  makeRpcError,
  parseRpcResponse,
  parseRpcRequest,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonRpcErrorBody,
  type JsonRpcErrorResponse,
  type JsonRpcResponse,
  type A2AMethod,
} from './jsonrpc.js';

// ── SSE parser ─────────────────────────────────────────────────────────────────
export { parseSseStream, sseData, sseComment } from './sse-parser.js';

// ── Push Notifications (Phase 5) ───────────────────────────────────────────────
export {
  createInMemoryPushNotificationStore,
  createDurablePushNotificationStore,
  type A2APushNotificationStore,
  type A2APushNotificationConfigEntry,
} from './push-notification-store.js';

export {
  deliverToWebhook,
  deliverPushNotificationsForTask,
  type PushDeliveryPayload,
} from './push-notification-delivery.js';

// ── Card Signer (Phase 5) ──────────────────────────────────────────────────────
export {
  signAgentCard,
  verifyAgentCard,
  generateCardSigningKeyPair,
  type CardVerificationResult,
} from './card-signer.js';

// ── JWT Validator (Phase 5) ────────────────────────────────────────────────────
export {
  createJwtValidator,
  createJtiCache,
  type JwtPayload,
  type JwtValidatorOptions,
  type JwtValidatorFn,
  type JtiCache,
} from './jwt-validator.js';

// ── Fetch options ──────────────────────────────────────────────────────────────
export type { A2AFetchOptions } from './_fetch.js';
