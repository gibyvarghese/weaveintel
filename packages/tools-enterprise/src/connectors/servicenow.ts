/**
 * ServiceNow REST API — Full connector
 *
 * Covers: Table API (CRUD on any table), Incident, Change Request,
 * Problem, Catalog, CMDB, User, Knowledge Base, Service Catalog.
 *
 * Base URL pattern: https://{instance}.service-now.com
 * Auth: Basic (username:password), OAuth 2.0, Bearer
 *
 * @see https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/
 */
import { BaseEnterpriseProvider } from '../base.js';
import type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions } from '../types.js';

function table(config: EnterpriseConnectorConfig, tableName: string, path = ''): string {
  return `${config.baseUrl}/api/now/table/${tableName}${path}`;
}

function apiUrl(config: EnterpriseConnectorConfig, path: string): string {
  return `${config.baseUrl}${path}`;
}

function toRecord(type: string, data: Record<string, unknown>, id?: string): EnterpriseRecord {
  return { id: String(id ?? data['sys_id'] ?? ''), type, source: 'servicenow', data };
}

export class ServiceNowProvider extends BaseEnterpriseProvider {
  readonly type = 'servicenow';

  /* ===== Generic Table API ===== */

  async query(options: EnterpriseQueryOptions, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const tableName = (options as unknown as Record<string, unknown>)['table'] as string ?? 'incident';
    const params = new URLSearchParams({
      sysparm_query: options.query,
      sysparm_limit: String(options.limit ?? 50),
    });
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      table(config, tableName, `?${params}`), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord(tableName, r, r['sys_id'] as string));
  }

  async get(id: string, config: EnterpriseConnectorConfig, tableName = 'incident'): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        table(config, tableName, `/${id}`), this.authHeaders(config));
      return toRecord(tableName, d.result, id);
    } catch { return null; }
  }

  async create(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const tableName = (data['__table'] as string) ?? 'incident';
    const body = { ...data };
    delete body['__table'];
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      table(config, tableName), this.authHeaders(config), JSON.stringify(body));
    return toRecord(tableName, d.result, d.result['sys_id'] as string);
  }

  async updateRecord(id: string, tableName: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchWithBody('PUT', table(config, tableName, `/${id}`), this.authHeaders(config), JSON.stringify(fields));
    return toRecord(tableName, d.result, id);
  }

  async patchRecord(id: string, tableName: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchWithBody('PATCH', table(config, tableName, `/${id}`), this.authHeaders(config), JSON.stringify(fields));
    return toRecord(tableName, d.result, id);
  }

  async deleteRecord(id: string, tableName: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchRaw('DELETE', table(config, tableName, `/${id}`), this.authHeaders(config));
  }

  /* ===== Incidents ===== */

  async listIncidents(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'incident' } as unknown as EnterpriseQueryOptions, config);
  }

  async createIncident(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'incident' }, config);
  }

  async updateIncident(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.updateRecord(id, 'incident', fields, config);
  }

  /* ===== Change Requests ===== */

  async listChangeRequests(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'change_request' } as unknown as EnterpriseQueryOptions, config);
  }

  async createChangeRequest(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'change_request' }, config);
  }

  /* ===== Problems ===== */

  async listProblems(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'problem' } as unknown as EnterpriseQueryOptions, config);
  }

  async createProblem(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'problem' }, config);
  }

  /* ===== CMDB ===== */

  async listCMDBItems(config: EnterpriseConnectorConfig, className = 'cmdb_ci', query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: className } as unknown as EnterpriseQueryOptions, config);
  }

  async getCMDBItem(id: string, className: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, className);
  }

  /* ===== Users ===== */

  async searchUsers(query: string, config: EnterpriseConnectorConfig, limit = 20): Promise<EnterpriseRecord[]> {
    return this.query({ query: `nameLIKE${query}`, limit, table: 'sys_user' } as unknown as EnterpriseQueryOptions, config);
  }

  async getUser(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_user');
  }

  /* ===== Knowledge Base ===== */

  async searchKnowledge(query: string, config: EnterpriseConnectorConfig, limit = 20): Promise<EnterpriseRecord[]> {
    return this.query({ query: `textLIKE${query}`, limit, table: 'kb_knowledge' } as unknown as EnterpriseQueryOptions, config);
  }

  /* ===== Service Catalog ===== */

  async listCatalogItems(config: EnterpriseConnectorConfig, limit = 50): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/sn_sc/servicecatalog/items?sysparm_limit=${limit}`), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord('catalog_item', r, r['sys_id'] as string));
  }

  async getCatalogItem(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        apiUrl(config, `/api/sn_sc/servicecatalog/items/${id}`), this.authHeaders(config));
      return toRecord('catalog_item', d.result, id);
    } catch { return null; }
  }

  async orderCatalogItem(id: string, variables: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_sc/servicecatalog/items/${id}/order_now`), this.authHeaders(config),
      JSON.stringify({ sysparm_quantity: 1, variables }));
    return toRecord('catalog_order', d.result, d.result['sys_id'] as string);
  }

  /* ===== Import Set ===== */

  async importSet(tableName: string, data: Record<string, unknown>[], config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/now/import/${tableName}`), this.authHeaders(config), JSON.stringify({ records: data }));
    return (d.result ?? []).map(r => toRecord('import', r, r['sys_id'] as string));
  }

  /* ===== Aggregate ===== */

  async aggregate(tableName: string, query: string, groupBy: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const params = new URLSearchParams({
      sysparm_query: query,
      sysparm_group_by: groupBy,
      sysparm_count: 'true',
    });
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/now/stats/${tableName}?${params}`), this.authHeaders(config));
    return (d.result ?? []).map((r, i) => toRecord('aggregate', r, String(i)));
  }

  /* ===== HTTP helpers ===== */

  protected async fetchWithBody(method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ result: Record<string, unknown> }> {
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body,
    });
    if (!resp.ok) throw new Error(`servicenow: ${method} ${resp.status} ${resp.statusText}`);
    return resp.json() as Promise<{ result: Record<string, unknown> }>;
  }

  protected async fetchRaw(method: string, url: string, headers: Record<string, string>): Promise<void> {
    const resp = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
    });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`servicenow: ${method} ${resp.status} ${resp.statusText}`);
    }
  }
}
