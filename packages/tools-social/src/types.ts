/**
 * Types for social media tools
 */

export interface SocialAccountConfig {
  platform: string;
  accountName: string;
  enabled: boolean;
  authType: 'oauth2' | 'api_key' | 'bearer';
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  baseUrl?: string;
  scopes?: string[];
  expiresAt?: string;
  options?: Record<string, string>;
}

export interface SocialPost {
  id: string;
  platform: string;
  text: string;
  author: string;
  authorId?: string;
  url?: string;
  createdAt: string;
  likes?: number;
  shares?: number;
  replies?: number;
  media?: Array<{ type: string; url: string }>;
  metadata?: Record<string, unknown>;
}

export interface SocialPostOptions {
  text: string;
  media?: Array<{ type: string; url: string }>;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface SocialSearchOptions {
  query: string;
  limit?: number;
  since?: string;
  until?: string;
}

export interface SocialProvider {
  readonly platform: string;
  search(options: SocialSearchOptions, config: SocialAccountConfig): Promise<SocialPost[]>;
  post(options: SocialPostOptions, config: SocialAccountConfig): Promise<SocialPost>;
  getProfile(userId: string, config: SocialAccountConfig): Promise<Record<string, unknown>>;
}
