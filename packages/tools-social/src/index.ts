/**
 * @weaveintel/tools-social — Social platform integrations
 */
export type { SocialAccountConfig, SocialPost, SocialPostOptions, SocialSearchOptions, SocialProvider } from './types.js';
export { BaseSocialProvider } from './base.js';
export { SlackProvider } from './platforms/slack.js';
export { DiscordProvider } from './platforms/discord.js';
export { GitHubProvider } from './platforms/github.js';
export { createSocialTools } from './mcp.js';

// Convenience aliases
export { createSocialTools as weaveSocialTools } from './mcp.js';
