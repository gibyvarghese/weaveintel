/**
 * @weaveintel/tools-social — Social platform integrations
 *
 * Platforms: Slack, Discord, GitHub, Facebook (full Graph API), Instagram (full IG API)
 */
export type { SocialAccountConfig, SocialPost, SocialPostOptions, SocialSearchOptions, SocialProvider } from './types.js';
export { BaseSocialProvider } from './base.js';

// Platforms
export { SlackProvider } from './platforms/slack.js';
export { DiscordProvider } from './platforms/discord.js';
export { GitHubProvider } from './platforms/github.js';
export { FacebookProvider } from './platforms/facebook.js';
export { InstagramProvider } from './platforms/instagram.js';

// MCP tool factory
export { createSocialTools } from './mcp.js';

// Convenience aliases
export { createSocialTools as weaveSocialTools } from './mcp.js';
