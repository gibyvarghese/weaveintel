// SPDX-License-Identifier: MIT
export {
	weaveMCPServer,
	inProcessMCPContext,
	callerAssertedMCPContext,
	MCPServerConfigError,
	type MCPContextFactory,
	type MCPRequestInfo,
	type WeaveMCPServerOptions,
} from './server.js';
export {
	createMCPStdioServerTransport,
	createMCPStreamableHttpServerTransport,
	type MCPStreamableHttpServerTransport,
} from './transports.js';
export {
	weaveRealMCPTransport,
	type RealMCPTransportOptions,
	type RealMCPTransportServer,
} from './http-transport.js';

// ── Transport-free JSON-RPC core (drive any transport, or use weaveMCPServer) ──
export type { McpTool, McpToolResult, McpServerInfo, McpHandlers, JsonRpcMessage } from './jsonrpc.js';
export { MCP_PROTOCOL_VERSION, mcpText, handleMcpMessage } from './jsonrpc.js';
export type { McpToolAnnotations } from './jsonrpc.js';

// ── Remote endpoint: 2025-11-25 and 2026-07-28 on one URL, scope-to-tool, manifest hashing, URL elicitation ──
export {
  weaveMcpEndpoint,
  MCP_ERROR_MANIFEST_CHANGED,
  MCP_ERROR_INSUFFICIENT_SCOPE,
  MCP_ERROR_UNAUTHENTICATED,
  type McpEndpoint,
  type McpEndpointOptions,
  type McpEndpointTool,
  type McpToolCall,
  type McpToolHandlerOutcome,
  type McpConfirmDecision,
  type McpHttpRequest,
  type McpHttpResponse,
  type McpServeOptions,
} from './endpoint.js';
export {
  MCP_PROTOCOL_VERSION_2025_11_25,
  MCP_PROTOCOL_VERSION_2026_07_28,
  MCP_SESSION_PROTOCOL_VERSIONS,
  MCP_STATELESS_PROTOCOL_VERSIONS,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_META_PROTOCOL_VERSION,
  mcpProtocolEra,
  negotiateMcpProtocolVersion,
  type McpProtocolEra,
  type McpVersionNegotiation,
  type McpVersionInput,
} from './protocol-versions.js';
export { MCP_MANIFEST_META_KEY, canonicalJson, manifestHash, parameterHash } from './manifest.js';
export {
  assertScopeToken,
  missingScopes,
  bearerChallenge,
  insufficientScopeChallenge,
  type BearerChallengeParams,
  type InsufficientScopeChallenge,
} from './scopes.js';
export {
  MCP_ERROR_URL_ELICITATION_REQUIRED,
  urlElicitationRequired,
  isUrlElicitationOutcome,
  assertUrlElicitation,
  readElicitationAnswers,
  type UrlElicitationRequest,
  type UrlElicitationOutcome,
  type ElicitationAnswer,
} from './elicitation.js';
