// SPDX-License-Identifier: MIT
export { weaveMCPServer } from './server.js';
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
