// SPDX-License-Identifier: MIT
/**
 * @weaveintel/connect/remote — remote tools (MCP) and remote agents (A2A) as governed connector calls: one pinned tool
 * or skill, through the caller's door, mapped by the same rows as an operation, declared outputs only.
 */
export { MCP_PROTOCOL_VERSIONS, comparePins, fingerprintTool, listRemoteTools, openMcpSession, runRemoteTool, type McpEndpoint, type McpSession, type PinDrift, type RemoteRunInput, type RemoteRunResult, type RemoteToolDescriptor, type RemoteToolSpec } from './mcp.js'
export { AGENT_TASK_STATES, cancelAgentTask, fingerprintCard, getAgentTask, normaliseState, readTask, resolveAgentCard, sendAgentMessage, summariseCard, type A2AVersion, type AgentCardSummary, type AgentRunInput, type AgentRunResult, type AgentSkillSpec, type AgentTaskState } from './a2a.js'
export { readSseEvents, rpc, rpcMessages, type RpcCall, type RpcError, type RpcResult } from './jsonrpc.js'
export { mapIntoArguments, mapOutputs } from './mapping.js'
