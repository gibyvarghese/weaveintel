/**
 * Instagram API (via Meta Graph API) — Full social provider
 *
 * Covers: Media (list, get, publish), Comments (CRUD), Insights,
 * Stories, Mentions, User Profile, Container-based publishing.
 *
 * Base URL: https://graph.facebook.com/v25.0
 * Auth: OAuth 2.0 — Instagram Login or Facebook Login
 * Scopes: instagram_business_basic, instagram_business_content_publish,
 *          instagram_business_manage_comments, instagram_business_manage_messages
 *
 * @see https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
 */
import { BaseSocialProvider } from '../base.js';
import type { SocialAccountConfig, SocialPost, SocialPostOptions, SocialSearchOptions } from '../types.js';

const DEFAULT_BASE = 'https://graph.facebook.com/v25.0';

function base(config: SocialAccountConfig): string {
  return config.baseUrl ?? DEFAULT_BASE;
}

function igUserId(config: SocialAccountConfig): string {
  return config.options?.['igUserId'] ?? 'me';
}

function toPost(data: Record<string, unknown>): SocialPost {
  return {
    id: String(data['id'] ?? ''),
    platform: 'instagram',
    text: String(data['caption'] ?? ''),
    author: String(data['username'] ?? ''),
    createdAt: String(data['timestamp'] ?? new Date().toISOString()),
    likes: data['like_count'] != null ? Number(data['like_count']) : undefined,
    replies: data['comments_count'] != null ? Number(data['comments_count']) : undefined,
    media: data['media_url'] ? [{ type: String(data['media_type'] ?? 'IMAGE'), url: String(data['media_url']) }] : undefined,
    metadata: data,
  };
}

export class InstagramProvider extends BaseSocialProvider {
  readonly platform = 'instagram';

  /* ===== Search (list media feed) ===== */

  async search(options: SocialSearchOptions, config: SocialAccountConfig): Promise<SocialPost[]> {
    const uid = igUserId(config);
    const params = new URLSearchParams({
      fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,username,permalink',
      limit: String(options.limit ?? 25),
    });
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${uid}/media?${params}`, this.authHeaders(config));
    return (d.data ?? []).map(toPost);
  }

  /* ===== Publish (container-based) ===== */

  async post(options: SocialPostOptions, config: SocialAccountConfig): Promise<SocialPost> {
    const uid = igUserId(config);
    const containerBody: Record<string, unknown> = { caption: options.text };

    if (options.media?.length) {
      const m = options.media[0]!;
      if (m.type === 'VIDEO' || m.type === 'REELS') {
        containerBody['media_type'] = 'REELS';
        containerBody['video_url'] = m.url;
      } else if (m.type === 'STORIES') {
        containerBody['media_type'] = 'STORIES';
        containerBody['image_url'] = m.url;
      } else {
        containerBody['image_url'] = m.url;
      }
    }

    // Step 1: create media container
    const container = await this.fetchJSON<{ id: string }>(
      `${base(config)}/${uid}/media`, this.authHeaders(config), JSON.stringify(containerBody));

    // Step 2: publish container
    const published = await this.fetchJSON<{ id: string }>(
      `${base(config)}/${uid}/media_publish`, this.authHeaders(config),
      JSON.stringify({ creation_id: container.id }));

    return { id: published.id, platform: 'instagram', text: options.text, author: config.accountName, createdAt: new Date().toISOString() };
  }

  async getProfile(userId: string, config: SocialAccountConfig): Promise<Record<string, unknown>> {
    const uid = userId || igUserId(config);
    return this.fetchJSON(
      `${base(config)}/${uid}?fields=id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website`,
      this.authHeaders(config));
  }

  /* ===== Media ===== */

  async getMedia(mediaId: string, config: SocialAccountConfig): Promise<SocialPost> {
    const d = await this.fetchJSON<Record<string, unknown>>(
      `${base(config)}/${mediaId}?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,username,permalink`,
      this.authHeaders(config));
    return toPost(d);
  }

  /* ===== Comments ===== */

  async getComments(mediaId: string, config: SocialAccountConfig, limit = 25): Promise<SocialPost[]> {
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${mediaId}/comments?fields=id,text,username,timestamp,like_count&limit=${limit}`,
      this.authHeaders(config));
    return (d.data ?? []).map(c => ({
      id: String(c['id']),
      platform: 'instagram',
      text: String(c['text'] ?? ''),
      author: String(c['username'] ?? ''),
      createdAt: String(c['timestamp'] ?? ''),
      likes: c['like_count'] != null ? Number(c['like_count']) : undefined,
    }));
  }

  async replyToComment(commentId: string, message: string, config: SocialAccountConfig): Promise<SocialPost> {
    const d = await this.fetchJSON<{ id: string }>(
      `${base(config)}/${commentId}/replies`, this.authHeaders(config), JSON.stringify({ message }));
    return { id: d.id, platform: 'instagram', text: message, author: config.accountName, createdAt: new Date().toISOString() };
  }

  async deleteComment(commentId: string, config: SocialAccountConfig): Promise<void> {
    await this.fetchRaw('DELETE', `${base(config)}/${commentId}`, this.authHeaders(config));
  }

  async hideComment(commentId: string, hide: boolean, config: SocialAccountConfig): Promise<void> {
    await this.fetchJSON(`${base(config)}/${commentId}`, this.authHeaders(config),
      JSON.stringify({ hide }));
  }

  /* ===== Stories ===== */

  async getStories(config: SocialAccountConfig): Promise<SocialPost[]> {
    const uid = igUserId(config);
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${uid}/stories?fields=id,media_type,media_url,timestamp`, this.authHeaders(config));
    return (d.data ?? []).map(toPost);
  }

  /* ===== Insights ===== */

  async getMediaInsights(mediaId: string, metrics: string[], config: SocialAccountConfig): Promise<Record<string, unknown>[]> {
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${mediaId}/insights?metric=${metrics.join(',')}`, this.authHeaders(config));
    return d.data ?? [];
  }

  async getUserInsights(metrics: string[], period: string, config: SocialAccountConfig): Promise<Record<string, unknown>[]> {
    const uid = igUserId(config);
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${uid}/insights?metric=${metrics.join(',')}&period=${period}`, this.authHeaders(config));
    return d.data ?? [];
  }

  /* ===== Mentions ===== */

  async getMentionedMedia(mentionId: string, config: SocialAccountConfig): Promise<SocialPost> {
    const uid = igUserId(config);
    const d = await this.fetchJSON<Record<string, unknown>>(
      `${base(config)}/${uid}?fields=mentioned_media.media_id(${mentionId}){id,caption,media_type,media_url,timestamp}`,
      this.authHeaders(config));
    return toPost((d['mentioned_media'] as Record<string, unknown>) ?? d);
  }

  /* ===== Hashtag Search ===== */

  async searchHashtag(hashtagName: string, config: SocialAccountConfig): Promise<string> {
    const uid = igUserId(config);
    const d = await this.fetchJSON<{ data: Array<{ id: string }> }>(
      `${base(config)}/ig_hashtag_search?q=${encodeURIComponent(hashtagName)}&user_id=${uid}`, this.authHeaders(config));
    return d.data?.[0]?.id ?? '';
  }

  async getHashtagMedia(hashtagId: string, edge: 'top_media' | 'recent_media', config: SocialAccountConfig, limit = 25): Promise<SocialPost[]> {
    const uid = igUserId(config);
    const d = await this.fetchJSON<{ data: Array<Record<string, unknown>> }>(
      `${base(config)}/${hashtagId}/${edge}?user_id=${uid}&fields=id,caption,media_type,media_url,timestamp,like_count,comments_count&limit=${limit}`,
      this.authHeaders(config));
    return (d.data ?? []).map(toPost);
  }

  /* ===== HTTP helper ===== */

  protected async fetchRaw(method: string, url: string, headers: Record<string, string>): Promise<void> {
    const resp = await fetch(url, { method, headers: { ...headers } });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`instagram: ${method} ${resp.status} ${resp.statusText}`);
    }
  }
}
