// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { handleMcpMessage, mcpText, MCP_PROTOCOL_VERSION, type McpHandlers, type McpTool } from './jsonrpc.js';

const TOOLS: McpTool[] = [
  { name: 'search_notes', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_note', description: 'Read', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
function handlers(over: Partial<McpHandlers> = {}): McpHandlers {
  return {
    serverInfo: { name: 'weaveNotes', version: '1.0.0', instructions: 'Search/read/write your notes.' },
    listTools: () => TOOLS,
    callTool: async (name, args) => mcpText(`called ${name} with ${JSON.stringify(args)}`),
    ...over,
  };
}

describe('mcp — protocol handler', () => {
  it('initialize → echoes a supported protocolVersion + capabilities + serverInfo', async () => {
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, handlers());
    expect(r).toMatchObject({ jsonrpc: '2.0', id: 1 });
    const res = (r as { result: Record<string, unknown> }).result;
    expect(res['protocolVersion']).toBe('2025-06-18');   // echoes the client's supported ask
    expect(res['capabilities']).toMatchObject({ tools: { listChanged: false } });
    expect((res['serverInfo'] as { name: string }).name).toBe('weaveNotes');
    expect(res['instructions']).toMatch(/notes/i);
  });
  it('initialize with an unknown version → falls back to our latest', async () => {
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, handlers());
    expect((r as { result: { protocolVersion: string } }).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });
  it('notifications/* → no response (HTTP 202)', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, handlers())).toBeNull();
  });
  it('tools/list → returns the tool registry', async () => {
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, handlers());
    const tools = (r as { result: { tools: McpTool[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(['search_notes', 'get_note']);
  });
  it('tools/call → dispatches to callTool and returns the content envelope', async () => {
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'mars' } } }, handlers());
    const res = (r as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }).result;
    expect(res.content[0]!.type).toBe('text');
    expect(res.content[0]!.text).toMatch(/search_notes.*mars/);
    expect(res.isError).toBe(false);
  });
  it('tools/call unknown tool → JSON-RPC error -32602', async () => {
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }, handlers());
    expect((r as { error: { code: number } }).error.code).toBe(-32602);
  });
  it('tools/call with missing name → invalid params', async () => {
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} }, handlers());
    expect((r as { error: { code: number } }).error.code).toBe(-32602);
  });
  it('a THROWING tool becomes an isError result, not a protocol crash (model can self-correct)', async () => {
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_note', arguments: { id: 'x' } } }, handlers({ callTool: async () => { throw new Error('boom'); } }));
    const res = (r as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/failed.*boom/i);
  });
  it('unknown method → -32601; malformed message → -32600', async () => {
    expect((await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'frobnicate' }, handlers()) as { error: { code: number } }).error.code).toBe(-32601);
    expect((await handleMcpMessage({ id: 8 } as never, handlers()) as { error: { code: number } }).error.code).toBe(-32600);
  });
  it('ping → empty result; resources/prompts list → empty (tools-only server)', async () => {
    expect((await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'ping' }, handlers()) as { result: unknown }).result).toEqual({});
    expect((await handleMcpMessage({ jsonrpc: '2.0', id: 10, method: 'resources/list' }, handlers()) as { result: { resources: unknown[] } }).result.resources).toEqual([]);
  });
});
