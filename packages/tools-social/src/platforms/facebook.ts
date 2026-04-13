/**
 * Facebook Graph API v25.0 — Full social provider
 *
 * Covers: Pages, Posts (CRUD), Comments (CRUD), Photos, Videos,
 * Insights, User Profile, Page Feed, Publishing.
 *
 * Base URL: https://graph.facebook.com/v25.0
 * Auth: OAuth 2.0 (User/Page access tokens)
 *
 * @see https://developers.facebook.com/docs/graph-api/reference
 */
import { BaseSocialProvider } from '../base.js';
import type { SocialAccountConfig, SocialPost, SocialPostOptions, SocialSearchOptions } from '../types.js';

const DEFAULT_BASE = 'https://graph.facebook.com/v25.0';

function base(config: SocialAccountConfig): string {
  return config.baseUrl ?? DEFAULT_BASE;
}

function toPost(data: Record<string, unknown>): SocialPost {
  return {
    id: String(data['id'] ?? ''),
    platform: 'facebook',
    text: String(data['message'] ?? data['story'] ?? ''),
    author: String((data['from'] as Record<string, unknown>)?.['name'] ?? ''),
    authorId: String((data['from'] as Record<string, unknown>)?.['id'] ?? ''),
    createdAt: String(data['created_time'] ?? new Date().toISOString()),
    likes: (data['likes'] as Record<string, unknown>)?.['summary'] ? Number((data['likes'] as Record<string, unknown>)['summary']) : undefined,
    shares: data['shares'] ? Number((data['shares'] as Record<string, unknown>)?.['count'] ?? 0) : undefined,
    metadata: data,
  };
}

export class FacebookProvider extends BaseSocialProvider {
  readonly platform = 'facebook';

  /* ===== Search / Feed ===== */

  async search(options: SocialSearchOptions, config: SocialAccountConfig): Promise<SocialPost[]> {
    const pageId = config.options?.['pageId'] ?? 'me';
    const params = new URLSearchParams({ fields: 'id,message,story,from,created_time,likes.summary(true),shares', limit: String(options.limit ?? 25) });
    if (options.since) params.set('since', options.since);
    if (options.until) params.set('until', options.until);
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${pageId}/feed?${params}`, this.authHeaders(config));
    return (d.data ?? []).map(toPost);
  }

  async post(options: SocialPostOptions, config: SocialAccountConfig): Promise<SocialPost> {
    const pageId = config.options?.['pageId'] ?? 'me';
    const body: Record<string, unknown> = { message: options.text };
    if (options.media?.length) body['link'] = options.media[0]!.url;
    const d = await this.fetchJSON<{ id: string }>(
      `${base(config)}/${pageId}/feed`, this.authHeaders(config), JSON.stringify(body));
    return { id: d.id, platform: 'facebook', text: options.text, author: config.accountName, createdAt: new Date().toISOString() };
  }

  async getProfile(userId: string, config: SocialAccountConfig): Promise<Record<string, unknown>> {
    const id = userId || 'me';
    return this.fetchJSON(`${base(config)}/${id}?fields=id,name,email,picture`, this.authHeaders(config));
  }

  /* ===== Posts (extended) ===== */

  async getPost(postId: string, config: SocialAccountConfig): Promise<SocialPost> {
    const d = await this.fetchJSON<Record<string, unknown>>(
      `${base(config)}/${postId}?fields=id,message,story,from,created_time,likes.summary(true),shares`, this.authHeaders(config));
    return toPost(d);
  }

  async updatePost(postId: string, message: string, config: SocialAccountConfig): Promise<void> {
    await this.fetchJSON(`${base(config)}/${postId}`, this.authHeaders(config), JSON.stringify({ message }));
  }

  async deletePost(postId: string, config: SocialAccountConfig): Promise<void> {
    await this.fetchRaw('DELETE', `${base(config)}/${postId}`, this.authHeaders(config));
  }

  /* ===== Comments ===== */

  async getComments(objectId: string, config: SocialAccountConfig, limit = 25): Promise<SocialPost[]> {
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${objectId}/comments?fields=id,message,from,created_time&limit=${limit}`, this.authHeaders(config));
    return (d.data ?? []).map(c => ({
      id: String(c['id']),
      platform: 'facebook',
      text: String(c['message'] ?? ''),
      author: String((c['from'] as Record<string, unknown>)?.['name'] ?? ''),
      createdAt: String(c['created_time'] ?? ''),
    }));
  }

  async addComment(objectId: string, message: string, config: SocialAccountConfig): Promise<SocialPost> {
    const d = await this.fetchJSON<{ id: string }>(
      `${base(config)}/${objectId}/comments`, this.authHeaders(config), JSON.stringify({ message }));
    return { id: d.id, platform: 'facebook', text: message, author: config.accountName, createdAt: new Date().toISOString() };
  }

  async deleteComment(commentId: string, config: SocialAccountConfig): Promise<void> {
    await this.fetchRaw('DELETE', `${base(config)}/${commentId}`, this.authHeaders(config));
  }

  /* ===== Photos ===== */

  async getPhotos(pageId: string, config: SocialAccountConfig, limit = 25): Promise<Record<string, unknown>[]> {
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${pageId}/photos?fields=id,name,picture,source,created_time&limit=${limit}`, this.authHeaders(config));
    return d.data ?? [];
  }

  async publishPhoto(pageId: string, url: string, caption: string, config: SocialAccountConfig): Promise<{ id: string }> {
    return this.fetchJSON(`${base(config)}/${pageId}/photos`, this.authHeaders(config),
      JSON.stringify({ url, caption }));
  }

  /* ===== Videos ===== */

  async getVideos(pageId: string, config: SocialAccountConfig, limit = 25): Promise<Record<string, unknown>[]> {
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${pageId}/videos?fields=id,title,description,source,created_time&limit=${limit}`, this.authHeaders(config));
    return d.data ?? [];
  }

  /* ===== Insights ===== */

  async getInsights(pageId: string, metrics: string[], period: string, config: SocialAccountConfig): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ metric: metrics.join(','), period });
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${pageId}/insights?${params}`, this.authHeaders(config));
    return d.data ?? [];
  }

  /* ===== Pages ===== */

  async getPage(pageId: string, config: SocialAccountConfig): Promise<Record<string, unknown>> {
    return this.fetchJSON(`${base(config)}/${pageId}?fields=id,name,category,fan_count,link,about,description,picture`, this.authHeaders(config));
  }

  async getPageAccessToken(pageId: string, config: SocialAccountConfig): Promise<string> {
    const d = await this.fetchJSON<{ access_token: string }>(
      `${base(config)}/${pageId}?fields=access_token`, this.authHeaders(config));
    return d.access_token;
  }

  /* ===== HTTP helpers ===== */

  protected async fetchRaw(method: string, url: string, headers: Record<string, string>): Promise<void> {
    const resp = await fetch(url, { method, headers: { ...headers } });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`facebook: ${method} ${resp.status} ${resp.statusText}`);
    }
  }
}
