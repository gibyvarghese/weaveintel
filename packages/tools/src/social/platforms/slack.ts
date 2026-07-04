/**
 * Slack social provider
 */
import { BaseSocialProvider } from '../base.js';
import type { SocialAccountConfig, SocialPost, SocialPostOptions, SocialSearchOptions } from '../types.js';

export class SlackProvider extends BaseSocialProvider {
  readonly platform = 'slack';

  async search(options: SocialSearchOptions, config: SocialAccountConfig): Promise<SocialPost[]> {
    const base = config.baseUrl ?? 'https://slack.com/api';
    const headers = this.authHeaders(config);
    const params = new URLSearchParams({ query: options.query, count: String(options.limit ?? 20) });
    const data = await this.fetchJSON<{
      messages?: { matches?: Array<{ iid: string; text: string; username: string; ts: string; permalink?: string }> };
    }>(`${base}/search.messages?${params.toString()}`, headers);
    return (data.messages?.matches ?? []).map(m => ({
      id: m.iid ?? m.ts,
      platform: 'slack',
      text: m.text,
      author: m.username,
      url: m.permalink,
      createdAt: new Date(Number(m.ts) * 1000).toISOString(),
    }));
  }

  async post(options: SocialPostOptions, config: SocialAccountConfig): Promise<SocialPost> {
    const base = config.baseUrl ?? 'https://slack.com/api';
    const headers = this.authHeaders(config);
    const channel = config.options?.['channel'] ?? 'general';
    const data = await this.fetchJSON<{ ok: boolean; ts: string; message?: { text: string } }>(
      `${base}/chat.postMessage`,
      headers,
      JSON.stringify({ channel, text: options.text }),
    );
    return { id: data.ts, platform: 'slack', text: options.text, author: config.accountName, createdAt: new Date().toISOString() };
  }

  async getProfile(userId: string, config: SocialAccountConfig): Promise<Record<string, unknown>> {
    const base = config.baseUrl ?? 'https://slack.com/api';
    const headers = this.authHeaders(config);
    return this.fetchJSON(`${base}/users.info?user=${userId}`, headers);
  }
}
