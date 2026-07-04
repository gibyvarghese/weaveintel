/**
 * MCP tool definitions for HTTP endpoints
 */
import type { Tool, ToolInput, ToolOutput, ToolSchema, ExecutionContext } from '@weaveintel/core';
import type { HttpEndpointConfig } from './types.js';
import { executeEndpoint } from './client.js';

function httpSchema(config: HttpEndpointConfig): ToolSchema {
  return {
    name: `http.${config.name}`,
    description: `HTTP ${config.method} to ${config.baseUrl}`,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Override URL (optional, defaults to endpoint baseUrl)' },
        method: { type: 'string', description: 'Override HTTP method' },
        body: { type: 'object', description: 'Request body (JSON)' },
        query: { type: 'string', description: 'Query parameter string' },
      },
    },
  };
}

/**
 * Create Tool objects from an array of HTTP endpoint configs.
 * Each config becomes a http.<name> tool.
 */
export function createHttpTools(endpoints: HttpEndpointConfig[]): Tool[] {
  return endpoints
    .filter(e => e.enabled !== false)
    .map(config => ({
      schema: httpSchema(config),
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const resp = await executeEndpoint(config, input.arguments as Record<string, unknown>);
        return { content: JSON.stringify({ status: resp.status, body: resp.body, latencyMs: resp.latencyMs }) };
      },
    }));
}
