/**
 * GitHub social provider
 */
import { BaseSocialProvider } from '../base.js';
import type { SocialAccountConfig, SocialPost, SocialPostOptions, SocialSearchOptions } from '../types.js';

export class GitHubProvider extends BaseSocialProvider {
  readonly platform = 'github';

  async search(options: SocialSearchOptions, config: SocialAccountConfig): Promise<SocialPost[]> {
    const base = config.baseUrl ?? 'https://api.github.com';
    const headers = this.authHeaders(config);
    const params = new URLSearchParams({ q: options.query, per_page: String(options.limit ?? 10) });
    const data = await this.fetchJSON<{
      items?: Array<{ id: number; title?: string; body?: string; html_url: string; user: { login: string; id: number }; created_at: string }>;
    }>(`${base}/search/issues?${params.toString()}`, headers);
    return (data.items ?? []).map(i => ({
      id: String(i.id),
      platform: 'github',
      text: `${i.title ?? ''}\n${i.body ?? ''}`.trim(),
      author: i.user.login,
      authorId: String(i.user.id),
      url: i.html_url,
      createdAt: i.created_at,
    }));
  }

  async post(options: SocialPostOptions, config: SocialAccountConfig): Promise<SocialPost> {
    const base = config.baseUrl ?? 'https://api.github.com';
    const repo = config.options?.['repo'] ?? '';
    const headers = this.authHeaders(config);
    const data = await this.fetchJSON<{ id: number; title: string; body: string; html_url: string; user: { login: string }; created_at: string }>(
      `${base}/repos/${repo}/issues`,
      headers,
      JSON.stringify({ title: options.text.slice(0, 100), body: options.text }),
    );
    return { id: String(data.id), platform: 'github', text: data.body, author: data.user.login, url: data.html_url, createdAt: data.created_at };
  }

  async getProfile(userId: string, config: SocialAccountConfig): Promise<Record<string, unknown>> {
    const base = config.baseUrl ?? 'https://api.github.com';
    const headers = this.authHeaders(config);
    return this.fetchJSON(`${base}/users/${userId}`, headers);
  }
}
