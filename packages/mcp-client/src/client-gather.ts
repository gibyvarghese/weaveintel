import type { MCPToolDefinition, MCPResource, MCPPrompt, JsonSchema } from '@weaveintel/core';
import { Client as SDKClient } from '@modelcontextprotocol/sdk/client/index.js';

export async function gatherAllTools(client: SDKClient): Promise<MCPToolDefinition[]> {
  const output: MCPToolDefinition[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    output.push(
      ...(result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.title ?? '',
        inputSchema: tool.inputSchema as JsonSchema,
      })),
    );
    cursor = result.nextCursor;
  } while (cursor);
  return output;
}

export async function gatherAllResources(client: SDKClient): Promise<MCPResource[]> {
  const output: MCPResource[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listResources(cursor ? { cursor } : undefined);
    output.push(
      ...(result.resources ?? []).map((resource) => ({
        uri: resource.uri,
        name: resource.name ?? resource.title ?? resource.uri,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
    );
    cursor = result.nextCursor;
  } while (cursor);
  return output;
}

export async function gatherAllPrompts(client: SDKClient): Promise<MCPPrompt[]> {
  const output: MCPPrompt[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listPrompts(cursor ? { cursor } : undefined);
    output.push(
      ...(result.prompts ?? []).map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments?.map((arg) => ({
          name: arg.name,
          description: arg.description,
          required: arg.required,
        })),
      })),
    );
    cursor = result.nextCursor;
  } while (cursor);
  return output;
}
