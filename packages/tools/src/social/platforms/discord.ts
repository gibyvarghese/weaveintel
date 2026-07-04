/**
 * Discord social provider
 */
import { BaseSocialProvider } from '../base.js';
import type { SocialAccountConfig, SocialPost, SocialPostOptions, SocialSearchOptions } from '../types.js';

export class DiscordProvider extends BaseSocialProvider {
  readonly platform = 'discord';

  async search(options: SocialSearchOptions, config: SocialAccountConfig): Promise<SocialPost[]> {
    const base = config.baseUrl ?? 'https://discord.com/api/v10';
    const guildId = config.options?.['guildId'] ?? '';
    const headers = { ...this.authHeaders(config), Authorization: `Bot ${config.accessToken ?? config.apiKey ?? ''}` };
    const params = new URLSearchParams({ content: options.query, limit: String(options.limit ?? 25) });
    const data = await this.fetchJSON<{
      messages?: Array<Array<{ id: string; content: string; author: { username: string; id: string }; timestamp: string }>>;
    }>(`${base}/guilds/${guildId}/messages/search?${params.toString()}`, headers);
    return (data.messages ?? []).flat().map(m => ({
      id: m.id,
      platform: 'discord',
      text: m.content,
      author: m.author.username,
      authorId: m.author.id,
      createdAt: m.timestamp,
    }));
  }

  async post(options: SocialPostOptions, config: SocialAccountConfig): Promise<SocialPost> {
    const base = config.baseUrl ?? 'https://discord.com/api/v10';
    const channelId = config.options?.['channelId'] ?? '';
    const headers = { ...this.authHeaders(config), Authorization: `Bot ${config.accessToken ?? config.apiKey ?? ''}` };
    const data = await this.fetchJSON<{ id: string; content: string; author: { username: string }; timestamp: string }>(
      `${base}/channels/${channelId}/messages`,
      headers,
      JSON.stringify({ content: options.text }),
    );
    return { id: data.id, platform: 'discord', text: data.content, author: data.author.username, createdAt: data.timestamp };
  }

  async getProfile(userId: string, config: SocialAccountConfig): Promise<Record<string, unknown>> {
    const base = config.baseUrl ?? 'https://discord.com/api/v10';
    const headers = { ...this.authHeaders(config), Authorization: `Bot ${config.accessToken ?? config.apiKey ?? ''}` };
    return this.fetchJSON(`${base}/users/${userId}`, headers);
  }
}
