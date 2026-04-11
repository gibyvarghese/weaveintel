/**
 * Notion connector
 */
import { BaseEnterpriseProvider } from '../base.js';
import type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions } from '../types.js';

export class NotionProvider extends BaseEnterpriseProvider {
  readonly type = 'notion';

  private headers(config: EnterpriseConnectorConfig): Record<string, string> {
    return { ...this.authHeaders(config), 'Notion-Version': '2022-06-28' };
  }

  async query(options: EnterpriseQueryOptions, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const base = config.baseUrl ?? 'https://api.notion.com/v1';
    const data = await this.fetchJSON<{
      results?: Array<{ id: string; object: string; properties?: Record<string, unknown>; created_time?: string }>;
    }>(`${base}/search`, this.headers(config), JSON.stringify({ query: options.query, page_size: options.limit ?? 20 }));
    return (data.results ?? []).map(r => ({
      id: r.id,
      type: r.object,
      source: 'notion',
      data: r.properties ?? {},
      createdAt: r.created_time,
    }));
  }

  async get(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    const base = config.baseUrl ?? 'https://api.notion.com/v1';
    try {
      const data = await this.fetchJSON<{ id: string; object: string; properties?: Record<string, unknown> }>(
        `${base}/pages/${id}`,
        this.headers(config),
      );
      return { id: data.id, type: data.object, source: 'notion', data: data.properties ?? {} };
    } catch {
      return null;
    }
  }

  async create(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const base = config.baseUrl ?? 'https://api.notion.com/v1';
    const result = await this.fetchJSON<{ id: string; object: string }>(
      `${base}/pages`,
      this.headers(config),
      JSON.stringify(data),
    );
    return { id: result.id, type: result.object, source: 'notion', data };
  }
}
