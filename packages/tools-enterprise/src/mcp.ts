/**
 * MCP tool definitions for enterprise connectors
 */
import type { Tool, ToolInput, ToolOutput, ExecutionContext } from '@weaveintel/core';
import type { EnterpriseConnectorConfig, EnterpriseProvider } from './types.js';
import { JiraProvider } from './connectors/jira.js';
import { ConfluenceProvider } from './connectors/confluence.js';
import { SalesforceProvider } from './connectors/salesforce.js';
import { NotionProvider } from './connectors/notion.js';

const BUILT_IN: EnterpriseProvider[] = [new JiraProvider(), new ConfluenceProvider(), new SalesforceProvider(), new NotionProvider()];

const QUERY_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search/query string' },
    limit: { type: 'number', description: 'Max results' },
  },
  required: ['query'],
} as const;

const GET_PARAMS = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Record ID' } },
  required: ['id'],
} as const;

export function createEnterpriseTools(
  configs: EnterpriseConnectorConfig[],
  extraProviders?: EnterpriseProvider[],
): Tool[] {
  const providerMap = new Map<string, EnterpriseProvider>();
  for (const p of [...BUILT_IN, ...(extraProviders ?? [])]) providerMap.set(p.type, p);

  const tools: Tool[] = [];

  for (const config of configs.filter(c => c.enabled)) {
    const provider = providerMap.get(config.type);
    if (!provider) continue;
    const prefix = `enterprise.${config.name}`;

    tools.push({
      schema: {
        name: `${prefix}.query`,
        description: `Query ${config.type} connector "${config.name}"`,
        parameters: QUERY_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const args = input.arguments;
        const results = await provider.query(
          { query: String(args['query']), limit: args['limit'] ? Number(args['limit']) : undefined },
          config,
        );
        return { content: JSON.stringify(results) };
      },
    });

    tools.push({
      schema: {
        name: `${prefix}.get`,
        description: `Get a record from ${config.type} connector "${config.name}"`,
        parameters: GET_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const result = await provider.get(String(input.arguments['id']), config);
        return { content: JSON.stringify(result) };
      },
    });

    tools.push({
      schema: {
        name: `${prefix}.create`,
        description: `Create a record in ${config.type} connector "${config.name}"`,
        parameters: { type: 'object', properties: { data: { type: 'object', description: 'Record data' } }, required: ['data'] },
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const data = input.arguments['data'] as Record<string, unknown>;
        const result = await provider.create(data, config);
        return { content: JSON.stringify(result) };
      },
    });
  }

  return tools;
}
