/**
 * Confluence connector
 */
import { BaseEnterpriseProvider } from '../base.js';
import type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions } from '../types.js';

export class ConfluenceProvider extends BaseEnterpriseProvider {
  readonly type = 'confluence';

  async query(options: EnterpriseQueryOptions, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const cql = options.query.includes('=') ? options.query : `text ~ "${options.query}"`;
    const params = new URLSearchParams({ cql, limit: String(options.limit ?? 20) });
    const data = await this.fetchJSON<{
      results?: Array<{ id: string; title: string; type: string; body?: { storage?: { value: string } }; _links?: { webui?: string } }>;
    }>(`${config.baseUrl}/rest/api/content/search?${params.toString()}`, this.authHeaders(config));
    return (data.results ?? []).map(r => ({
      id: r.id,
      type: r.type,
      source: 'confluence',
      data: { title: r.title, body: r.body?.storage?.value ?? '', link: r._links?.webui ?? '' },
    }));
  }

  async get(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const data = await this.fetchJSON<{ id: string; title: string; type: string; body?: { storage?: { value: string } } }>(
        `${config.baseUrl}/rest/api/content/${id}?expand=body.storage`,
        this.authHeaders(config),
      );
      return { id: data.id, type: data.type, source: 'confluence', data: { title: data.title, body: data.body?.storage?.value ?? '' } };
    } catch {
      return null;
    }
  }

  async create(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const result = await this.fetchJSON<{ id: string; title: string; type: string }>(
      `${config.baseUrl}/rest/api/content`,
      this.authHeaders(config),
      JSON.stringify(data),
    );
    return { id: result.id, type: result.type, source: 'confluence', data: { title: result.title, ...data } };
  }
}
