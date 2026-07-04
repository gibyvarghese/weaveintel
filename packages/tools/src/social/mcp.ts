/**
 * MCP tool definitions for social platforms
 *
 * Generates tools for: Slack, Discord, GitHub (base 3),
 * Facebook (full Graph API), Instagram (full IG API).
 */
import type { Tool, ToolInput, ToolOutput, ExecutionContext } from '@weaveintel/core';
import type { SocialAccountConfig, SocialProvider } from './types.js';
import { SlackProvider } from './platforms/slack.js';
import { DiscordProvider } from './platforms/discord.js';
import { GitHubProvider } from './platforms/github.js';
import { FacebookProvider } from './platforms/facebook.js';
import { InstagramProvider } from './platforms/instagram.js';

const BUILT_IN: SocialProvider[] = [new SlackProvider(), new DiscordProvider(), new GitHubProvider(), new FacebookProvider(), new InstagramProvider()];

/* ---------- extended providers ---------- */
const FACEBOOK = new FacebookProvider();
const INSTAGRAM = new InstagramProvider();

/* ---------- reusable param schemas ---------- */

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

/* ---------- tool builder helper ---------- */
type ToolDef = { name: string; desc: string; params: Record<string, unknown>; fn: (ctx: ExecutionContext, input: ToolInput) => Promise<ToolOutput> };
function buildTool(d: ToolDef): Tool {
  return { schema: { name: d.name, description: d.desc, parameters: d.params }, invoke: d.fn };
}
function ok(data: unknown): ToolOutput { return { content: JSON.stringify(data) }; }

/* ---------- Facebook extended tools ---------- */
function facebookExtendedTools(prefix: string, config: SocialAccountConfig): Tool[] {
  const p = FACEBOOK;
  return [
    buildTool({ name: `${prefix}.getPost`, desc: 'Get a Facebook post by ID',
      params: { type: 'object', properties: { postId: { type: 'string' } }, required: ['postId'] },
      fn: async (_c, inp) => ok(await p.getPost(String(inp.arguments['postId']), config)) }),
    buildTool({ name: `${prefix}.updatePost`, desc: 'Update a Facebook post',
      params: { type: 'object', properties: { postId: { type: 'string' }, message: { type: 'string' } }, required: ['postId', 'message'] },
      fn: async (_c, inp) => { await p.updatePost(String(inp.arguments['postId']), String(inp.arguments['message']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.deletePost`, desc: 'Delete a Facebook post',
      params: { type: 'object', properties: { postId: { type: 'string' } }, required: ['postId'] },
      fn: async (_c, inp) => { await p.deletePost(String(inp.arguments['postId']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.comments`, desc: 'Get comments on a Facebook post/object',
      params: { type: 'object', properties: { objectId: { type: 'string' }, limit: { type: 'number' } }, required: ['objectId'] },
      fn: async (_c, inp) => ok(await p.getComments(String(inp.arguments['objectId']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.addComment`, desc: 'Add a comment to a Facebook post',
      params: { type: 'object', properties: { objectId: { type: 'string' }, message: { type: 'string' } }, required: ['objectId', 'message'] },
      fn: async (_c, inp) => ok(await p.addComment(String(inp.arguments['objectId']), String(inp.arguments['message']), config)) }),
    buildTool({ name: `${prefix}.deleteComment`, desc: 'Delete a Facebook comment',
      params: { type: 'object', properties: { commentId: { type: 'string' } }, required: ['commentId'] },
      fn: async (_c, inp) => { await p.deleteComment(String(inp.arguments['commentId']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.photos`, desc: 'List photos on a Facebook page',
      params: { type: 'object', properties: { pageId: { type: 'string' }, limit: { type: 'number' } }, required: ['pageId'] },
      fn: async (_c, inp) => ok(await p.getPhotos(String(inp.arguments['pageId']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.publishPhoto`, desc: 'Publish a photo to a Facebook page',
      params: { type: 'object', properties: { pageId: { type: 'string' }, url: { type: 'string' }, caption: { type: 'string' } }, required: ['pageId', 'url'] },
      fn: async (_c, inp) => ok(await p.publishPhoto(String(inp.arguments['pageId']), String(inp.arguments['url']), String(inp.arguments['caption'] ?? ''), config)) }),
    buildTool({ name: `${prefix}.videos`, desc: 'List videos on a Facebook page',
      params: { type: 'object', properties: { pageId: { type: 'string' }, limit: { type: 'number' } }, required: ['pageId'] },
      fn: async (_c, inp) => ok(await p.getVideos(String(inp.arguments['pageId']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.insights`, desc: 'Get Facebook page insights',
      params: { type: 'object', properties: { pageId: { type: 'string' }, metrics: { type: 'array', items: { type: 'string' } }, period: { type: 'string' } }, required: ['pageId', 'metrics', 'period'] },
      fn: async (_c, inp) => ok(await p.getInsights(String(inp.arguments['pageId']), inp.arguments['metrics'] as string[], String(inp.arguments['period']), config)) }),
    buildTool({ name: `${prefix}.page`, desc: 'Get Facebook page info',
      params: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] },
      fn: async (_c, inp) => ok(await p.getPage(String(inp.arguments['pageId']), config)) }),
    buildTool({ name: `${prefix}.pageToken`, desc: 'Get a page access token',
      params: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] },
      fn: async (_c, inp) => ok({ accessToken: await p.getPageAccessToken(String(inp.arguments['pageId']), config) }) }),
  ];
}

/* ---------- Instagram extended tools ---------- */
function instagramExtendedTools(prefix: string, config: SocialAccountConfig): Tool[] {
  const p = INSTAGRAM;
  return [
    buildTool({ name: `${prefix}.getMedia`, desc: 'Get an Instagram media post by ID',
      params: { type: 'object', properties: { mediaId: { type: 'string' } }, required: ['mediaId'] },
      fn: async (_c, inp) => ok(await p.getMedia(String(inp.arguments['mediaId']), config)) }),
    buildTool({ name: `${prefix}.comments`, desc: 'Get comments on an Instagram media post',
      params: { type: 'object', properties: { mediaId: { type: 'string' }, limit: { type: 'number' } }, required: ['mediaId'] },
      fn: async (_c, inp) => ok(await p.getComments(String(inp.arguments['mediaId']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.replyComment`, desc: 'Reply to an Instagram comment',
      params: { type: 'object', properties: { commentId: { type: 'string' }, message: { type: 'string' } }, required: ['commentId', 'message'] },
      fn: async (_c, inp) => ok(await p.replyToComment(String(inp.arguments['commentId']), String(inp.arguments['message']), config)) }),
    buildTool({ name: `${prefix}.deleteComment`, desc: 'Delete an Instagram comment',
      params: { type: 'object', properties: { commentId: { type: 'string' } }, required: ['commentId'] },
      fn: async (_c, inp) => { await p.deleteComment(String(inp.arguments['commentId']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.hideComment`, desc: 'Hide/unhide an Instagram comment',
      params: { type: 'object', properties: { commentId: { type: 'string' }, hide: { type: 'boolean' } }, required: ['commentId', 'hide'] },
      fn: async (_c, inp) => { await p.hideComment(String(inp.arguments['commentId']), Boolean(inp.arguments['hide']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.stories`, desc: 'Get Instagram stories',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.getStories(config)) }),
    buildTool({ name: `${prefix}.mediaInsights`, desc: 'Get insights for an Instagram media post',
      params: { type: 'object', properties: { mediaId: { type: 'string' }, metrics: { type: 'array', items: { type: 'string' } } }, required: ['mediaId', 'metrics'] },
      fn: async (_c, inp) => ok(await p.getMediaInsights(String(inp.arguments['mediaId']), inp.arguments['metrics'] as string[], config)) }),
    buildTool({ name: `${prefix}.userInsights`, desc: 'Get Instagram user/account insights',
      params: { type: 'object', properties: { metrics: { type: 'array', items: { type: 'string' } }, period: { type: 'string' } }, required: ['metrics', 'period'] },
      fn: async (_c, inp) => ok(await p.getUserInsights(inp.arguments['metrics'] as string[], String(inp.arguments['period']), config)) }),
    buildTool({ name: `${prefix}.searchHashtag`, desc: 'Search for an Instagram hashtag ID',
      params: { type: 'object', properties: { hashtag: { type: 'string' } }, required: ['hashtag'] },
      fn: async (_c, inp) => ok({ hashtagId: await p.searchHashtag(String(inp.arguments['hashtag']), config) }) }),
    buildTool({ name: `${prefix}.hashtagMedia`, desc: 'Get top/recent media for a hashtag',
      params: { type: 'object', properties: { hashtagId: { type: 'string' }, edge: { type: 'string', description: 'top_media or recent_media' }, limit: { type: 'number' } }, required: ['hashtagId'] },
      fn: async (_c, inp) => ok(await p.getHashtagMedia(String(inp.arguments['hashtagId']), (inp.arguments['edge'] as 'top_media' | 'recent_media') ?? 'top_media', config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
  ];
}

/* ---------- main factory ---------- */

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

    // Base tools (search/post/profile) — common to all providers
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

    // Extended tools for Facebook and Instagram
    if (config.platform === 'facebook') {
      tools.push(...facebookExtendedTools(prefix, config));
    }

    if (config.platform === 'instagram') {
      tools.push(...instagramExtendedTools(prefix, config));
    }
  }

  return tools;
}
