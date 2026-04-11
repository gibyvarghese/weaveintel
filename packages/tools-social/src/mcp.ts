/**
 * MCP tool definitions for social platforms
 */
import type { Tool, ToolInput, ToolOutput, ExecutionContext } from '@weaveintel/core';
import type { SocialAccountConfig, SocialProvider } from './types.js';
import { SlackProvider } from './platforms/slack.js';
import { DiscordProvider } from './platforms/discord.js';
import { GitHubProvider } from './platforms/github.js';

const BUILT_IN: SocialProvider[] = [new SlackProvider(), new DiscordProvider(), new GitHubProvider()];

const SEARCH_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    limit: { type: 'number', description: 'Max results' },
  },
  required: ['query'],
} as const;

const POST_PARAMS = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Message/post text' },
  },
  required: ['text'],
} as const;

export function createSocialTools(
  configs: SocialAccountConfig[],
  extraProviders?: SocialProvider[],
): Tool[] {
  const providerMap = new Map<string, SocialProvider>();
  for (const p of [...BUILT_IN, ...(extraProviders ?? [])]) providerMap.set(p.platform, p);

  const tools: Tool[] = [];

  for (const config of configs.filter(c => c.enabled)) {
    const provider = providerMap.get(config.platform);
    if (!provider) continue;
    const prefix = `social.${config.platform}`;

    tools.push({
      schema: {
        name: `${prefix}.search`,
        description: `Search ${config.platform} (${config.accountName})`,
        parameters: SEARCH_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const args = input.arguments;
        const results = await provider.search({ query: String(args['query']), limit: args['limit'] ? Number(args['limit']) : undefined }, config);
        return { content: JSON.stringify(results) };
      },
    });

    tools.push({
      schema: {
        name: `${prefix}.post`,
        description: `Post to ${config.platform} (${config.accountName})`,
        parameters: POST_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const args = input.arguments;
        const result = await provider.post({ text: String(args['text']) }, config);
        return { content: JSON.stringify(result) };
      },
    });

    tools.push({
      schema: {
        name: `${prefix}.profile`,
        description: `Get user profile on ${config.platform}`,
        parameters: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const result = await provider.getProfile(String(input.arguments['userId']), config);
        return { content: JSON.stringify(result) };
      },
    });
  }

  return tools;
}
