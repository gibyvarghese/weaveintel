/**
 * Types for browser/web tooling
 */

export interface FetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
}

export interface FetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  html: string;
  latencyMs: number;
}

export interface ExtractedContent {
  title: string;
  text: string;
  links: Array<{ href: string; text: string }>;
  images: Array<{ src: string; alt: string }>;
  metadata: Record<string, string>;
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface ReadabilityResult {
  title: string;
  content: string;
  textContent: string;
  length: number;
  excerpt: string;
  siteName?: string;
  byline?: string;
}

export interface ScraperConfig {
  selectors: Record<string, string>;
  pagination?: { nextSelector: string; maxPages: number };
  waitMs?: number;
}

export interface ScrapedData {
  url: string;
  data: Record<string, string | string[]>;
}
