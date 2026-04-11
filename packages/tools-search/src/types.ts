/**
 * @weaveintel/tools-search — Types
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  language?: string;
  region?: string;
  safeSearch?: boolean;
}

export interface SearchProviderConfig {
  name: string;
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  priority?: number;
  rateLimit?: number;
  options?: Record<string, unknown>;
}

export interface SearchProvider {
  readonly name: string;
  search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]>;
}
