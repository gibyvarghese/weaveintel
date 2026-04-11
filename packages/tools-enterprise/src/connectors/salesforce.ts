/**
 * Salesforce connector
 */
import { BaseEnterpriseProvider } from '../base.js';
import type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions } from '../types.js';

export class SalesforceProvider extends BaseEnterpriseProvider {
  readonly type = 'salesforce';

  async query(options: EnterpriseQueryOptions, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const soql = options.query.toUpperCase().startsWith('SELECT') ? options.query : `SELECT Id, Name FROM Account WHERE Name LIKE '%${options.query}%' LIMIT ${options.limit ?? 20}`;
    const params = new URLSearchParams({ q: soql });
    const data = await this.fetchJSON<{
      records?: Array<{ Id: string; attributes?: { type: string }; [key: string]: unknown }>;
    }>(`${config.baseUrl}/services/data/v59.0/query?${params.toString()}`, this.authHeaders(config));
    return (data.records ?? []).map(r => ({
      id: r.Id,
      type: r.attributes?.type ?? 'record',
      source: 'salesforce',
      data: r,
    }));
  }

  async get(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    const objType = config.options?.['objectType'] ?? 'Account';
    try {
      const data = await this.fetchJSON<Record<string, unknown>>(
        `${config.baseUrl}/services/data/v59.0/sobjects/${objType}/${id}`,
        this.authHeaders(config),
      );
      return { id, type: objType, source: 'salesforce', data };
    } catch {
      return null;
    }
  }

  async create(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const objType = config.options?.['objectType'] ?? 'Account';
    const result = await this.fetchJSON<{ id: string; success: boolean }>(
      `${config.baseUrl}/services/data/v59.0/sobjects/${objType}`,
      this.authHeaders(config),
      JSON.stringify(data),
    );
    return { id: result.id, type: objType, source: 'salesforce', data };
  }
}
