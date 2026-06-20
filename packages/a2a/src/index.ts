// SPDX-License-Identifier: MIT

// ── Client + bus ───────────────────────────────────────────────────────────────
export { weaveA2AClient, weaveA2ABus } from './a2a.js';

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

// ── Fetch options ──────────────────────────────────────────────────────────────
export type { A2AFetchOptions } from './_fetch.js';
