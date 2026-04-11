/**
 * Base social provider with HTTP helpers
 */
import type { SocialAccountConfig, SocialPost, SocialPostOptions, SocialSearchOptions, SocialProvider } from './types.js';

export abstract class BaseSocialProvider implements SocialProvider {
  abstract readonly platform: string;
  abstract search(options: SocialSearchOptions, config: SocialAccountConfig): Promise<SocialPost[]>;
  abstract post(options: SocialPostOptions, config: SocialAccountConfig): Promise<SocialPost>;
  abstract getProfile(userId: string, config: SocialAccountConfig): Promise<Record<string, unknown>>;

  protected authHeaders(config: SocialAccountConfig): Record<string, string> {
    switch (config.authType) {
      case 'bearer':
      case 'oauth2':
        return { Authorization: `Bearer ${config.accessToken ?? config.apiKey ?? ''}` };
      case 'api_key':
        return { 'X-API-Key': config.apiKey ?? '' };
      default:
        return {};
    }
  }

  protected async fetchJSON<T>(url: string, headers: Record<string, string>, body?: string): Promise<T> {
    const resp = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    if (!resp.ok) throw new Error(`${this.platform}: ${resp.status} ${resp.statusText}`);
    return resp.json() as Promise<T>;
  }
}
