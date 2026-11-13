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
  type A2ADispatcherOptions,
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
  type PushDeliveryOptions,
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

// ── A2A v0.3 compatibility fields (0.2.0) ──────────────────────────────────────
export {
  withV03Compat,
  checkV03Card,
  A2A_V03_PROTOCOL_VERSION,
  type A2AV03Transport,
  type AgentInterfaceV03,
  type AgentCardV03Fields,
  type DualVersionAgentCard,
  type WithV03CompatOptions,
} from './card-v03.js';

// ── Card signatures in the A2A wire form, verified against a JWKS (0.2.0) ──────
export {
  canonicalizeJson,
  signAgentCardJws,
  verifyAgentCardJws,
  exportCardSigningJwk,
  buildCardJwks,
  type AgentCardJwsSignature,
  type CardSigningJwk,
  type CardJwks,
  type CardJwsFailure,
  type CardJwsVerification,
  type SignCardJwsOptions,
  type VerifyCardJwsOptions,
} from './card-jws.js';

// ── Scoped (tenant-isolated) task store port, in-memory and Postgres (0.2.0) ───
export {
  createInMemoryScopedA2ATaskStore,
  bindA2ATaskScope,
  newA2ATaskId,
  A2A_LIST_MAX_PAGE_SIZE,
  type A2ATaskScope,
  type A2AScopedTaskStore,
} from './task-store-scoped.js';

export {
  createPostgresA2ATaskStore,
  a2aTaskPostgresDdl,
  type A2APgQueryable,
  type A2APostgresTaskStoreOptions,
} from './task-store-postgres.js';

export {
  a2aScopedTaskStoreContract,
  type A2AScopedTaskStoreContractApi,
} from './scoped-task-store-contract.js';

// ── Push configs through the outbound guard (0.2.0) ────────────────────────────
export {
  validatePushNotificationConfig,
  A2APushConfigError,
  A2A_PUSH_URL_MAX_LENGTH,
  type A2APushPolicy,
  type A2APushConfigErrorCode,
} from './push-guard.js';
