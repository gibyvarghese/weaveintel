/**
 * Jira connector
 */
import { BaseEnterpriseProvider } from '../base.js';
import type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions } from '../types.js';

export class JiraProvider extends BaseEnterpriseProvider {
  readonly type = 'jira';

  async query(options: EnterpriseQueryOptions, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const jql = options.query;
    const params = new URLSearchParams({ jql, maxResults: String(options.limit ?? 20) });
    const data = await this.fetchJSON<{
      issues?: Array<{ id: string; key: string; fields: Record<string, unknown> }>;
    }>(`${config.baseUrl}/rest/api/3/search?${params.toString()}`, this.authHeaders(config));
    return (data.issues ?? []).map(i => ({
      id: i.key,
      type: 'issue',
      source: 'jira',
      data: { key: i.key, ...i.fields },
    }));
  }

  async get(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const data = await this.fetchJSON<{ id: string; key: string; fields: Record<string, unknown> }>(
        `${config.baseUrl}/rest/api/3/issue/${id}`,
        this.authHeaders(config),
      );
      return { id: data.key, type: 'issue', source: 'jira', data: { key: data.key, ...data.fields } };
    } catch {
      return null;
    }
  }

  async create(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const result = await this.fetchJSON<{ id: string; key: string }>(
      `${config.baseUrl}/rest/api/3/issue`,
      this.authHeaders(config),
      JSON.stringify({ fields: data }),
    );
    return { id: result.key, type: 'issue', source: 'jira', data: { key: result.key, ...data } };
  }
}
