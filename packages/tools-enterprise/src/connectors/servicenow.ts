/**
 * ServiceNow REST API — Full connector
 *
 * Covers all 13 phases of the ServiceNow roadmap:
 *   Phase 0: Table API (CRUD on any table), Incident, Change, Problem, Catalog, CMDB, Users, Knowledge
 *   Phase 1: Attachment, Batch, Email, SCIM, User Roles & Groups
 *   Phase 2: CMDB deep, Discovery, Cloud Management
 *   Phase 3: Import Set, CSV/Excel, Transform Maps, Export
 *   Phase 4: Service Catalog deep (categories, variables, cart, requests, approvals)
 *   Phase 5: Change/Problem deep, SLA
 *   Phase 6: Security Operations, Scripted REST
 *   Phase 7: Performance Analytics, Reporting, Dashboards
 *   Phase 8: Integration Hub, Flow Designer, Orchestration
 *   Phase 9: ITSM deep (Incident lifecycle, CSM, HR, Interactions)
 *   Phase 10: DevOps, CI/CD, Update Sets, App Repository
 *   Phase 11: NLU, Virtual Agent, Predictive Intelligence
 *   Phase 12: Admin, Governance (Properties, ACLs, Scheduled Jobs, Audit, Plugins)
 *   Phase 13: Development & Configuration (Catalog Items, Record Producers, Flows,
 *             Notifications, Business Rules, Client Scripts, UI Policies, Data Policies,
 *             Script Includes, Scheduled Scripts, UI Actions, Workflows, Approval Rules,
 *             Assignment Rules, SLA Definitions, Inbound Email, Dictionary/Schema,
 *             App Scopes, Modules, Service Portal, Knowledge Management)
 *
 * Base URL pattern: https://{instance}.service-now.com
 * Auth: Basic (username:password), OAuth 2.0, Bearer
 *
 * @see https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/
 */
import { BaseEnterpriseProvider } from '../base.js';
import type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions } from '../types.js';
import { validateTableName, validateSysId, validateApiPath, validateHttpMethod, validateBaseUrl, MAX_ATTACHMENT_BYTES } from '../validation.js';

function table(config: EnterpriseConnectorConfig, tableName: string, path = ''): string {
  const base = validateBaseUrl(config.baseUrl);
  const safe = validateTableName(tableName);
  return `${base}/api/now/table/${safe}${path}`;
}

function apiUrl(config: EnterpriseConnectorConfig, path: string): string {
  const base = validateBaseUrl(config.baseUrl);
  return `${base}${path}`;
}

function toRecord(type: string, data: Record<string, unknown>, id?: string): EnterpriseRecord {
  return { id: String(id ?? data['sys_id'] ?? ''), type, source: 'servicenow', data };
}

export class ServiceNowProvider extends BaseEnterpriseProvider {
  readonly type = 'servicenow';

  /**
   * Refresh the OAuth2 access token using the refresh_token grant.
   * Returns the new token data or null if refresh is not possible/fails.
   */
  async refreshOAuthToken(
    baseUrl: string,
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
    const base = validateBaseUrl(baseUrl);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });
    try {
      const resp = await fetch(`${base}/oauth_token.do`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!resp.ok) {
        console.error(`[servicenow] Token refresh failed: HTTP ${resp.status}`);
        return null;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      const newToken = data['access_token'] as string | undefined;
      const newRefresh = (data['refresh_token'] as string | undefined) ?? refreshToken;
      const expiresIn = Number(data['expires_in'] ?? 1799);
      if (!newToken) {
        console.error('[servicenow] Token refresh returned no access_token');
        return null;
      }
      return { accessToken: newToken, refreshToken: newRefresh, expiresIn };
    } catch (err) {
      console.error('[servicenow] Token refresh error:', err);
      return null;
    }
  }

  /* ================================================================
   *  PHASE 0 — Generic Table API (EXISTING)
   * ================================================================ */

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
    const safeId = validateSysId(id);
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        table(config, tableName, `/${safeId}`), this.authHeaders(config));
      return toRecord(tableName, d.result, safeId);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
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
    const safeId = validateSysId(id);
    const d = await this.fetchWithBody('PUT', table(config, tableName, `/${safeId}`), this.authHeaders(config), JSON.stringify(fields));
    return toRecord(tableName, d.result, safeId);
  }

  async patchRecord(id: string, tableName: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const safeId = validateSysId(id);
    const d = await this.fetchWithBody('PATCH', table(config, tableName, `/${safeId}`), this.authHeaders(config), JSON.stringify(fields));
    return toRecord(tableName, d.result, safeId);
  }

  async deleteRecord(id: string, tableName: string, config: EnterpriseConnectorConfig): Promise<void> {
    const safeId = validateSysId(id);
    await this.fetchRaw('DELETE', table(config, tableName, `/${safeId}`), this.authHeaders(config));
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
    const safeId = validateSysId(id);
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        apiUrl(config, `/api/sn_sc/servicecatalog/items/${safeId}`), this.authHeaders(config));
      return toRecord('catalog_item', d.result, safeId);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
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

  /* ================================================================
   *  PHASE 1 — Attachment, Batch, Email, SCIM, User Roles & Groups
   * ================================================================ */

  /* ----- 1A: Attachment API ----- */

  async listAttachments(tableName: string, sysId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const params = new URLSearchParams({ sysparm_query: `table_name=${tableName}^table_sys_id=${sysId}` });
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/now/attachment?${params}`), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord('attachment', r, r['sys_id'] as string));
  }

  async getAttachment(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    const safeId = validateSysId(id);
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        apiUrl(config, `/api/now/attachment/${safeId}`), this.authHeaders(config));
      return toRecord('attachment', d.result, safeId);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async downloadAttachment(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const safeId = validateSysId(id);
    const resp = await fetch(apiUrl(config, `/api/now/attachment/${safeId}/file`), {
      headers: { ...this.authHeaders(config) },
    });
    if (!resp.ok) throw new Error(`servicenow: GET attachment file ${resp.status}`);
    const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB size limit.`);
    }
    const b64 = Buffer.from(buffer).toString('base64');
    return toRecord('attachment_file', { content_type: contentType, base64: b64, size: buffer.byteLength }, safeId);
  }

  async uploadAttachment(tableName: string, sysId: string, fileName: string, contentType: string, content: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const params = new URLSearchParams({ table_name: tableName, table_sys_id: sysId, file_name: fileName });
    const resp = await fetch(apiUrl(config, `/api/now/attachment/file?${params}`), {
      method: 'POST',
      headers: { 'Content-Type': contentType, ...this.authHeaders(config) },
      body: Buffer.from(content, 'base64'),
    });
    if (!resp.ok) throw new Error(`servicenow: POST attachment ${resp.status}`);
    const d = await resp.json() as { result: Record<string, unknown> };
    return toRecord('attachment', d.result, d.result['sys_id'] as string);
  }

  async deleteAttachment(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    const safeId = validateSysId(id);
    await this.fetchRaw('DELETE', apiUrl(config, `/api/now/attachment/${safeId}`), this.authHeaders(config));
  }

  /* ----- 1B: Batch API ----- */

  async batchRequest(requests: Array<{ id: string; method: string; url: string; body?: unknown; headers?: Record<string, string> }>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const sanitised = requests.map(r => {
      validateHttpMethod(r.method);
      if (!r.url.startsWith('/api/')) throw new Error(`Batch sub-request URL must start with /api/. Got: "${r.url}".`);
      const { headers: _stripped, ...rest } = r;          // drop user-supplied headers to prevent auth override
      return rest;
    });
    const d = await this.fetchJSON<{ serviced_requests: Array<Record<string, unknown>> }>(
      apiUrl(config, '/api/now/batch'), this.authHeaders(config),
      JSON.stringify({ batch_request_payload: { use_parallel: true, rest_requests: sanitised } }));
    return (d.serviced_requests ?? []).map((r, i) => toRecord('batch_response', r, String(i)));
  }

  /* ----- 1C: Email API ----- */

  async sendEmail(to: string, subject: string, body: string, config: EnterpriseConnectorConfig, options?: Record<string, unknown>): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      table(config, 'sys_email'), this.authHeaders(config),
      JSON.stringify({ type: 'send', recipients: to, subject, body, ...(options ?? {}) }));
    return toRecord('email', d.result, d.result['sys_id'] as string);
  }

  async listEmails(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_email' } as unknown as EnterpriseQueryOptions, config);
  }

  /* ----- 1D: SCIM API ----- */

  async scimListUsers(config: EnterpriseConnectorConfig, filter = '', count = 50): Promise<EnterpriseRecord[]> {
    const params = new URLSearchParams({ count: String(count), ...(filter ? { filter } : {}) });
    const d = await this.fetchJSON<{ Resources?: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/now/scim/Users?${params}`), this.authHeaders(config));
    return (d.Resources ?? []).map(r => toRecord('scim_user', r, r['id'] as string));
  }

  async scimGetUser(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<Record<string, unknown>>(
        apiUrl(config, `/api/now/scim/Users/${id}`), this.authHeaders(config));
      return toRecord('scim_user', d, id);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async scimCreateUser(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<Record<string, unknown>>(
      apiUrl(config, '/api/now/scim/Users'), this.authHeaders(config), JSON.stringify(data));
    return toRecord('scim_user', d, d['id'] as string);
  }

  async scimUpdateUser(id: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchWithBody('PUT', apiUrl(config, `/api/now/scim/Users/${id}`), this.authHeaders(config), JSON.stringify(data));
    return toRecord('scim_user', d.result, id);
  }

  async scimDeleteUser(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchRaw('DELETE', apiUrl(config, `/api/now/scim/Users/${id}`), this.authHeaders(config));
  }

  async scimListGroups(config: EnterpriseConnectorConfig, filter = '', count = 50): Promise<EnterpriseRecord[]> {
    const params = new URLSearchParams({ count: String(count), ...(filter ? { filter } : {}) });
    const d = await this.fetchJSON<{ Resources?: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/now/scim/Groups?${params}`), this.authHeaders(config));
    return (d.Resources ?? []).map(r => toRecord('scim_group', r, r['id'] as string));
  }

  async scimGetGroup(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<Record<string, unknown>>(
        apiUrl(config, `/api/now/scim/Groups/${id}`), this.authHeaders(config));
      return toRecord('scim_group', d, id);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async scimCreateGroup(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<Record<string, unknown>>(
      apiUrl(config, '/api/now/scim/Groups'), this.authHeaders(config), JSON.stringify(data));
    return toRecord('scim_group', d, d['id'] as string);
  }

  async scimUpdateGroup(id: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchWithBody('PUT', apiUrl(config, `/api/now/scim/Groups/${id}`), this.authHeaders(config), JSON.stringify(data));
    return toRecord('scim_group', d.result, id);
  }

  /* ----- 1E: User Roles & Groups ----- */

  async listUserRoles(userId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `user=${userId}`, limit: 200, table: 'sys_user_has_role' } as unknown as EnterpriseQueryOptions, config);
  }

  async assignUserRole(userId: string, roleId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ __table: 'sys_user_has_role', user: userId, role: roleId }, config);
  }

  async removeUserRole(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.deleteRecord(id, 'sys_user_has_role', config);
  }

  async listGroupMembers(groupId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `group=${groupId}`, limit: 200, table: 'sys_user_grmember' } as unknown as EnterpriseQueryOptions, config);
  }

  async addGroupMember(groupId: string, userId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ __table: 'sys_user_grmember', group: groupId, user: userId }, config);
  }

  async removeGroupMember(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.deleteRecord(id, 'sys_user_grmember', config);
  }

  /* ================================================================
   *  PHASE 2 — CMDB Deep, Discovery, Cloud Management
   * ================================================================ */

  async cmdbGetCI(id: string, className: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    const safeId = validateSysId(id);
    const safeCls = validateTableName(className);
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        apiUrl(config, `/api/now/cmdb/instance/${safeCls}/${safeId}`), this.authHeaders(config));
      return toRecord(safeCls, d.result, safeId);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async cmdbCreateCI(className: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const safeCls = validateTableName(className);
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/cmdb/instance/${safeCls}`), this.authHeaders(config), JSON.stringify(data));
    return toRecord(safeCls, d.result, d.result['sys_id'] as string);
  }

  async cmdbUpdateCI(id: string, className: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const safeId = validateSysId(id);
    const safeCls = validateTableName(className);
    const d = await this.fetchWithBody('PATCH', apiUrl(config, `/api/now/cmdb/instance/${safeCls}/${safeId}`), this.authHeaders(config), JSON.stringify(data));
    return toRecord(safeCls, d.result, safeId);
  }

  async cmdbDeleteCI(id: string, className: string, config: EnterpriseConnectorConfig): Promise<void> {
    const safeId = validateSysId(id);
    const safeCls = validateTableName(className);
    await this.fetchRaw('DELETE', apiUrl(config, `/api/now/cmdb/instance/${safeCls}/${safeId}`), this.authHeaders(config));
  }

  async cmdbGetRelationships(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const safeId = validateSysId(id);
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/now/cmdb/instance/cmdb_rel_ci?sysparm_query=parent=${safeId}^ORchild=${safeId}`), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord('cmdb_rel', r, r['sys_id'] as string));
  }

  async cmdbCreateRelationship(parentId: string, childId: string, typeId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ __table: 'cmdb_rel_ci', parent: parentId, child: childId, type: typeId }, config);
  }

  async cmdbDeleteRelationship(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.deleteRecord(id, 'cmdb_rel_ci', config);
  }

  async cmdbIdentifyCI(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, '/api/now/cmdb/instance/identify'), this.authHeaders(config), JSON.stringify(data));
    return toRecord('cmdb_identify', d.result, d.result['sys_id'] as string);
  }

  async cmdbListClasses(config: EnterpriseConnectorConfig, query = '', limit = 100): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'cmdb_ci' } as unknown as EnterpriseQueryOptions, config);
  }

  async cmdbGetClassSchema(className: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `name=${className}`, limit: 500, table: 'sys_dictionary' } as unknown as EnterpriseQueryOptions, config);
  }

  async cloudListResources(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'cmdb_ci_cloud_service_account' } as unknown as EnterpriseQueryOptions, config);
  }

  async cloudGetResource(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'cmdb_ci_cloud_service_account');
  }

  /* ================================================================
   *  PHASE 3 — Import Set, CSV/Excel, Transform Maps, Export
   * ================================================================ */

  async importSetInsert(tableName: string, data: Record<string, unknown>[], config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/now/import/${tableName}`), this.authHeaders(config), JSON.stringify({ records: data }));
    return (d.result ?? []).map(r => toRecord('import_set', r, r['sys_id'] as string));
  }

  async importSetGetStatus(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_import_set');
  }

  async importSetTransform(importSetId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/import/${importSetId}/transform`), this.authHeaders(config), JSON.stringify({}));
    return toRecord('transform_result', d.result, importSetId);
  }

  async importCSV(tableName: string, csvContent: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const resp = await fetch(apiUrl(config, `/api/now/import/${tableName}/insertMultiple`), {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', ...this.authHeaders(config) },
      body: csvContent,
    });
    if (!resp.ok) throw new Error(`servicenow: CSV import ${resp.status}`);
    const d = await resp.json() as { result: Record<string, unknown> };
    return toRecord('csv_import', d.result, d.result['sys_id'] as string ?? 'import');
  }

  async importExcel(tableName: string, base64Content: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const resp = await fetch(apiUrl(config, `/api/now/import/${tableName}/insertMultiple`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ...this.authHeaders(config) },
      body: Buffer.from(base64Content, 'base64'),
    });
    if (!resp.ok) throw new Error(`servicenow: Excel import ${resp.status}`);
    const d = await resp.json() as { result: Record<string, unknown> };
    return toRecord('excel_import', d.result, d.result['sys_id'] as string ?? 'import');
  }

  async exportTable(tableName: string, query: string, format: string, config: EnterpriseConnectorConfig, limit = 1000): Promise<EnterpriseRecord> {
    const params = new URLSearchParams({ sysparm_query: query, sysparm_limit: String(limit) });
    const accept = format === 'csv' ? 'text/csv' : format === 'xml' ? 'application/xml' : 'application/json';
    const resp = await fetch(table(config, tableName, `?${params}`), {
      headers: { Accept: accept, ...this.authHeaders(config) },
    });
    if (!resp.ok) throw new Error(`servicenow: export ${resp.status}`);
    const text = await resp.text();
    return toRecord('export', { format, content: text, table: tableName }, 'export');
  }

  async listTransformMaps(importSetTable: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `source_table=${importSetTable}`, limit: 100, table: 'sys_transform_map' } as unknown as EnterpriseQueryOptions, config);
  }

  async getTransformMap(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_transform_map');
  }

  /* ================================================================
   *  PHASE 4 — Service Catalog Deep
   * ================================================================ */

  async listCatalogs(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, '/api/sn_sc/servicecatalog/catalogs'), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord('catalog', r, r['sys_id'] as string));
  }

  async getCatalog(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    const safeId = validateSysId(id);
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        apiUrl(config, `/api/sn_sc/servicecatalog/catalogs/${safeId}`), this.authHeaders(config));
      return toRecord('catalog', d.result, safeId);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async listCategories(catalogId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/sn_sc/servicecatalog/catalogs/${catalogId}/categories`), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord('category', r, r['sys_id'] as string));
  }

  async getCategory(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    const safeId = validateSysId(id);
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        apiUrl(config, `/api/sn_sc/servicecatalog/categories/${safeId}`), this.authHeaders(config));
      return toRecord('category', d.result, safeId);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async getCatalogItemVariables(itemId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/sn_sc/servicecatalog/items/${itemId}/variables`), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord('catalog_variable', r, r['sys_id'] as string));
  }

  async getCatalogItemVariableSet(itemId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `sc_cat_item=${itemId}`, limit: 100, table: 'io_set_item' } as unknown as EnterpriseQueryOptions, config);
  }

  async addToCart(itemId: string, variables: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_sc/servicecatalog/items/${itemId}/add_to_cart`), this.authHeaders(config),
      JSON.stringify({ sysparm_quantity: 1, variables }));
    return toRecord('cart_item', d.result, d.result['cart_item_id'] as string ?? '');
  }

  async getCart(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, '/api/sn_sc/servicecatalog/cart'), this.authHeaders(config));
    return toRecord('cart', d.result, 'cart');
  }

  async updateCartItem(cartItemId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchWithBody('PATCH', apiUrl(config, `/api/sn_sc/servicecatalog/cart/${cartItemId}`), this.authHeaders(config), JSON.stringify(data));
    return toRecord('cart_item', d.result, cartItemId);
  }

  async deleteCartItem(cartItemId: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchRaw('DELETE', apiUrl(config, `/api/sn_sc/servicecatalog/cart/${cartItemId}`), this.authHeaders(config));
  }

  async checkoutCart(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, '/api/sn_sc/servicecatalog/cart/checkout'), this.authHeaders(config), JSON.stringify({}));
    return toRecord('checkout', d.result, d.result['request_number'] as string ?? '');
  }

  async emptyCart(config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchRaw('DELETE', apiUrl(config, '/api/sn_sc/servicecatalog/cart'), this.authHeaders(config));
  }

  async listRequests(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sc_request' } as unknown as EnterpriseQueryOptions, config);
  }

  async getRequest(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sc_request');
  }

  async listRequestItems(requestId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `request=${requestId}`, limit: 100, table: 'sc_req_item' } as unknown as EnterpriseQueryOptions, config);
  }

  async getRequestItem(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sc_req_item');
  }

  async listApprovals(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query: query || 'state=requested', limit, table: 'sysapproval_approver' } as unknown as EnterpriseQueryOptions, config);
  }

  async getApproval(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sysapproval_approver');
  }

  async approveRequest(id: string, config: EnterpriseConnectorConfig, comments = ''): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sysapproval_approver', { state: 'approved', comments }, config);
  }

  async rejectRequest(id: string, config: EnterpriseConnectorConfig, comments = ''): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sysapproval_approver', { state: 'rejected', comments }, config);
  }

  /* ================================================================
   *  PHASE 5 — Change Management Deep, Problem Deep, SLA
   * ================================================================ */

  async getChangeRequest(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'change_request');
  }

  async updateChangeRequest(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'change_request', fields, config);
  }

  async listChangeTasks(changeId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `change_request=${changeId}`, limit: 100, table: 'change_task' } as unknown as EnterpriseQueryOptions, config);
  }

  async createChangeTask(changeId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, change_request: changeId, __table: 'change_task' }, config);
  }

  async updateChangeTask(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'change_task', fields, config);
  }

  async getChangeSchedule(config: EnterpriseConnectorConfig, query = ''): Promise<EnterpriseRecord[]> {
    return this.query({ query: query || 'type=blackout', limit: 50, table: 'cmn_schedule' } as unknown as EnterpriseQueryOptions, config);
  }

  async checkChangeConflict(changeId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_chg_rest/change/${changeId}/conflict`), this.authHeaders(config), JSON.stringify({}));
    return toRecord('conflict_check', d.result, changeId);
  }

  async getProblem(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'problem');
  }

  async updateProblem(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'problem', fields, config);
  }

  async listKnownErrors(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query: query || 'known_error=true', limit, table: 'problem' } as unknown as EnterpriseQueryOptions, config);
  }

  async createKnownError(problemId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(problemId, 'problem', { known_error: 'true' }, config);
  }

  async listTaskSLAs(taskId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `task=${taskId}`, limit: 50, table: 'task_sla' } as unknown as EnterpriseQueryOptions, config);
  }

  async getTaskSLA(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'task_sla');
  }

  async pauseTaskSLA(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'task_sla', { stage: 'paused' }, config);
  }

  async resumeTaskSLA(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'task_sla', { stage: 'in_progress' }, config);
  }

  /* ================================================================
   *  PHASE 6 — Security Operations, Scripted REST
   * ================================================================ */

  async listSecurityIncidents(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sn_si_incident' } as unknown as EnterpriseQueryOptions, config);
  }

  async getSecurityIncident(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sn_si_incident');
  }

  async createSecurityIncident(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sn_si_incident' }, config);
  }

  async updateSecurityIncident(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sn_si_incident', fields, config);
  }

  async listVulnerabilities(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sn_vul_vulnerability' } as unknown as EnterpriseQueryOptions, config);
  }

  async listObservables(incidentId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `security_incident=${incidentId}`, limit: 100, table: 'sn_si_observable' } as unknown as EnterpriseQueryOptions, config);
  }

  async addObservable(incidentId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, security_incident: incidentId, __table: 'sn_si_observable' }, config);
  }

  async callScriptedREST(method: string, path: string, config: EnterpriseConnectorConfig, body?: Record<string, unknown>): Promise<EnterpriseRecord> {
    const safeMethod = validateHttpMethod(method);
    const safePath = validateApiPath(path);
    const url = apiUrl(config, safePath);
    if (body && (safeMethod === 'POST' || safeMethod === 'PUT' || safeMethod === 'PATCH')) {
      const d = await this.fetchWithBody(safeMethod, url, this.authHeaders(config), JSON.stringify(body));
      return toRecord('scripted_rest', d.result, 'response');
    }
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(url, this.authHeaders(config));
    return toRecord('scripted_rest', d.result, 'response');
  }

  async listScriptedRESTApis(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: 'active=true', limit: 100, table: 'sys_ws_definition' } as unknown as EnterpriseQueryOptions, config);
  }

  /* ================================================================
   *  PHASE 7 — Performance Analytics, Reporting, Dashboards
   * ================================================================ */

  async paGetScorecard(indicatorId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/pa/scorecards?indicator=${indicatorId}`), this.authHeaders(config));
    return toRecord('pa_scorecard', d.result, indicatorId);
  }

  async paListIndicators(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query: query || 'active=true', limit, table: 'pa_indicators' } as unknown as EnterpriseQueryOptions, config);
  }

  async paGetIndicatorScores(indicatorId: string, config: EnterpriseConnectorConfig, periods = 12): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/pa/scores?indicator=${indicatorId}&sysparm_display_value=true&sysparm_periods=${periods}`), this.authHeaders(config));
    return toRecord('pa_scores', d.result, indicatorId);
  }

  async paGetBreakdown(indicatorId: string, breakdownId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/pa/scores?indicator=${indicatorId}&breakdown=${breakdownId}`), this.authHeaders(config));
    return toRecord('pa_breakdown', d.result, indicatorId);
  }

  async listReports(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_report' } as unknown as EnterpriseQueryOptions, config);
  }

  async getReport(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_report');
  }

  async runReport(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/report/${id}/execute`), this.authHeaders(config));
    return toRecord('report_result', d.result, id);
  }

  async listDashboards(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_portal_page' } as unknown as EnterpriseQueryOptions, config);
  }

  async getDashboard(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_portal_page');
  }

  /* ================================================================
   *  PHASE 8 — Integration Hub, Flow Designer, Orchestration
   * ================================================================ */

  async listFlows(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query: query || 'active=true', limit, table: 'sys_hub_flow' } as unknown as EnterpriseQueryOptions, config);
  }

  async getFlow(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_hub_flow');
  }

  async triggerFlow(flowId: string, inputs: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_flow/flow/${flowId}/trigger`), this.authHeaders(config), JSON.stringify(inputs));
    return toRecord('flow_execution', d.result, d.result['execution_id'] as string ?? flowId);
  }

  async getFlowExecution(executionId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        apiUrl(config, `/api/sn_flow/flow/execution/${executionId}`), this.authHeaders(config));
      return toRecord('flow_execution', d.result, executionId);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async listFlowExecutions(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_flow_context' } as unknown as EnterpriseQueryOptions, config);
  }

  async listActions(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query: query || 'active=true', limit, table: 'sys_hub_action_type_definition' } as unknown as EnterpriseQueryOptions, config);
  }

  async executeAction(actionId: string, inputs: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_flow/action/${actionId}/execute`), this.authHeaders(config), JSON.stringify(inputs));
    return toRecord('action_execution', d.result, d.result['execution_id'] as string ?? actionId);
  }

  async getActionExecution(executionId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
        apiUrl(config, `/api/sn_flow/action/execution/${executionId}`), this.authHeaders(config));
      return toRecord('action_execution', d.result, executionId);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async listMidServers(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: '', limit: 100, table: 'ecc_agent' } as unknown as EnterpriseQueryOptions, config);
  }

  async getMidServer(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'ecc_agent');
  }

  /* ================================================================
   *  PHASE 9 — ITSM Deep (Incident lifecycle, CSM, HR, Interactions)
   * ================================================================ */

  async resolveIncident(id: string, resolution: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'incident', { state: '6', close_code: resolution['close_code'] ?? 'Solved (Permanently)', close_notes: resolution['close_notes'] ?? '', ...resolution }, config);
  }

  async closeIncident(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'incident', { state: '7' }, config);
  }

  async reassignIncident(id: string, assignmentGroup: string, assignedTo: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'incident', { assignment_group: assignmentGroup, assigned_to: assignedTo }, config);
  }

  async escalateIncident(id: string, newPriority: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'incident', { priority: newPriority, escalation: '1' }, config);
  }

  async listIncidentTasks(incidentId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `parent=${incidentId}`, limit: 100, table: 'incident_task' } as unknown as EnterpriseQueryOptions, config);
  }

  async createIncidentTask(incidentId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, parent: incidentId, __table: 'incident_task' }, config);
  }

  async listCases(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sn_customerservice_case' } as unknown as EnterpriseQueryOptions, config);
  }

  async getCase(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sn_customerservice_case');
  }

  async createCase(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sn_customerservice_case' }, config);
  }

  async updateCase(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sn_customerservice_case', fields, config);
  }

  async listHRCases(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sn_hr_core_case' } as unknown as EnterpriseQueryOptions, config);
  }

  async getHRCase(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sn_hr_core_case');
  }

  async createHRCase(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sn_hr_core_case' }, config);
  }

  async createInteraction(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'interaction' }, config);
  }

  async getInteraction(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'interaction');
  }

  /* ================================================================
   *  PHASE 10 — DevOps, CI/CD, Update Sets, App Repository
   * ================================================================ */

  async devopsListPipelines(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sn_devops_pipeline' } as unknown as EnterpriseQueryOptions, config);
  }

  async devopsGetPipeline(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sn_devops_pipeline');
  }

  async devopsCreateChangeFromPipeline(pipelineId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_devops/change`), this.authHeaders(config),
      JSON.stringify({ pipeline: pipelineId, ...data }));
    return toRecord('devops_change', d.result, d.result['sys_id'] as string);
  }

  async devopsGetArtifact(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sn_devops_artifact');
  }

  async devopsListArtifactVersions(artifactId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `artifact=${artifactId}`, limit: 50, table: 'sn_devops_artifact_version' } as unknown as EnterpriseQueryOptions, config);
  }

  async appRepoListApps(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, '/api/sn_cicd/app_repo/applications'), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord('app', r, r['sys_id'] as string));
  }

  async appRepoInstall(appId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_cicd/app_repo/install?sys_id=${appId}`), this.authHeaders(config), JSON.stringify({}));
    return toRecord('app_install', d.result, appId);
  }

  async appRepoGetAvailableUpdates(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, '/api/sn_cicd/app_repo/updates'), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord('app_update', r, r['sys_id'] as string));
  }

  async appRepoRollback(appId: string, version: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_cicd/app_repo/rollback?sys_id=${appId}&version=${version}`), this.authHeaders(config), JSON.stringify({}));
    return toRecord('app_rollback', d.result, appId);
  }

  async listUpdateSets(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_update_set' } as unknown as EnterpriseQueryOptions, config);
  }

  async getUpdateSet(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_update_set');
  }

  async createUpdateSet(name: string, description: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ __table: 'sys_update_set', name, description, state: 'in progress' }, config);
  }

  async commitUpdateSet(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_update_set', { state: 'complete' }, config);
  }

  async retrieveUpdateSet(url: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    // Validate the remote URL is a service-now.com instance to prevent SSRF
    validateBaseUrl(url);
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_cicd/updateset/retrieve?update_set_url=${encodeURIComponent(url)}`), this.authHeaders(config), JSON.stringify({}));
    return toRecord('retrieved_update_set', d.result, d.result['sys_id'] as string);
  }

  async previewUpdateSet(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const safeId = validateSysId(id);
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_cicd/updateset/preview?update_set_sys_id=${safeId}`), this.authHeaders(config), JSON.stringify({}));
    return toRecord('preview_result', d.result, safeId);
  }

  async applyUpdateSet(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const safeId = validateSysId(id);
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_cicd/updateset/apply?update_set_sys_id=${safeId}`), this.authHeaders(config), JSON.stringify({}));
    return toRecord('apply_result', d.result, safeId);
  }

  /* ================================================================
   *  PHASE 11 — NLU, Virtual Agent, Predictive Intelligence
   * ================================================================ */

  async nluPredict(text: string, modelId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/nlu/predict`), this.authHeaders(config),
      JSON.stringify({ text, model_id: modelId }));
    return toRecord('nlu_prediction', d.result, 'prediction');
  }

  async nluListModels(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: 'active=true', limit: 100, table: 'sys_nlu_model' } as unknown as EnterpriseQueryOptions, config);
  }

  async nluGetModel(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_nlu_model');
  }

  async nluAddTrainingData(modelId: string, utterance: string, intentId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ __table: 'sys_nlu_utterance', model: modelId, utterance, intent: intentId }, config);
  }

  async vaListTopics(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: 'active=true', limit: 100, table: 'sys_cs_topic' } as unknown as EnterpriseQueryOptions, config);
  }

  async vaStartConversation(topicId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, '/api/sn_va/conversation/start'), this.authHeaders(config),
      JSON.stringify({ topic: topicId }));
    return toRecord('va_conversation', d.result, d.result['conversation_id'] as string ?? '');
  }

  async vaSendMessage(conversationId: string, message: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, '/api/sn_va/conversation/message'), this.authHeaders(config),
      JSON.stringify({ conversation_id: conversationId, message }));
    return toRecord('va_message', d.result, conversationId);
  }

  async piClassify(tableName: string, recordId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/predict/classify?table=${tableName}&sys_id=${recordId}`), this.authHeaders(config));
    return toRecord('pi_classification', d.result, recordId);
  }

  async piSimilarity(tableName: string, recordId: string, config: EnterpriseConnectorConfig, limit = 10): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ result: Array<Record<string, unknown>> }>(
      apiUrl(config, `/api/now/predict/similarity?table=${tableName}&sys_id=${recordId}&limit=${limit}`), this.authHeaders(config));
    return (d.result ?? []).map(r => toRecord('pi_similar', r, r['sys_id'] as string));
  }

  async piGetSolution(tableName: string, recordId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/predict/solution?table=${tableName}&sys_id=${recordId}`), this.authHeaders(config));
    return toRecord('pi_solution', d.result, recordId);
  }

  /* ================================================================
   *  PHASE 12 — Admin, Governance, Platform
   * ================================================================ */

  async getProperty(name: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    const results = await this.query({ query: `name=${name}`, limit: 1, table: 'sys_properties' } as unknown as EnterpriseQueryOptions, config);
    return results[0] ?? null;
  }

  async setProperty(name: string, value: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const existing = await this.getProperty(name, config);
    if (existing) {
      return this.patchRecord(existing.id, 'sys_properties', { value }, config);
    }
    return this.create({ __table: 'sys_properties', name, value }, config);
  }

  async listProperties(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_properties' } as unknown as EnterpriseQueryOptions, config);
  }

  async listACLs(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_security_acl' } as unknown as EnterpriseQueryOptions, config);
  }

  async getACL(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_security_acl');
  }

  async createACL(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_security_acl' }, config);
  }

  async listScheduledJobs(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sysauto' } as unknown as EnterpriseQueryOptions, config);
  }

  async getScheduledJob(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sysauto');
  }

  async createScheduledJob(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sysauto' }, config);
  }

  async toggleScheduledJob(id: string, active: boolean, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sysauto', { active: active ? 'true' : 'false' }, config);
  }

  async listAuditLogs(config: EnterpriseConnectorConfig, query = '', limit = 100): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_audit' } as unknown as EnterpriseQueryOptions, config);
  }

  async listSystemLogs(config: EnterpriseConnectorConfig, query = '', limit = 100): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'syslog' } as unknown as EnterpriseQueryOptions, config);
  }

  async listTransactionLogs(config: EnterpriseConnectorConfig, query = '', limit = 100): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'syslog_transaction' } as unknown as EnterpriseQueryOptions, config);
  }

  async listPlugins(config: EnterpriseConnectorConfig, query = '', limit = 100): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'v_plugin' } as unknown as EnterpriseQueryOptions, config);
  }

  async activatePlugin(pluginId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/sn_cicd/plugin/${pluginId}/activate`), this.authHeaders(config), JSON.stringify({}));
    return toRecord('plugin_activation', d.result, pluginId);
  }

  /* ================================================================
   *  PHASE 13 — Development & Configuration Activities
   * ================================================================ */

  /* --- 13A: Catalog Item Management (sc_cat_item) --- */

  async createCatalogItemRecord(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sc_cat_item' }, config);
  }

  async updateCatalogItemRecord(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sc_cat_item', fields, config);
  }

  async deleteCatalogItemRecord(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.deleteRecord(id, 'sc_cat_item', config);
  }

  async cloneCatalogItemRecord(sourceId: string, newName: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const source = await this.get(sourceId, config, 'sc_cat_item');
    if (!source) throw new Error(`Catalog item ${sourceId} not found`);
    const cloneData = { ...source.data, name: newName, sys_id: undefined };
    delete cloneData['sys_id'];
    const cloned = await this.create({ ...cloneData, __table: 'sc_cat_item' }, config);
    // Clone variables too
    const vars = await this.query({ query: `cat_item=${sourceId}`, limit: 500, table: 'item_option_new' } as unknown as EnterpriseQueryOptions, config);
    for (const v of vars) {
      const vd = { ...v.data, cat_item: cloned.id, sys_id: undefined };
      delete vd['sys_id'];
      await this.create({ ...vd, __table: 'item_option_new' }, config);
    }
    return cloned;
  }

  /* --- 13B: Catalog Variable Management (item_option_new) --- */

  async listCatalogVariablesAdmin(catItemId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `cat_item=${catItemId}^ORDERBYorder`, limit: 500, table: 'item_option_new' } as unknown as EnterpriseQueryOptions, config);
  }

  async createCatalogVariable(catItemId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, cat_item: catItemId, __table: 'item_option_new' }, config);
  }

  async updateCatalogVariable(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'item_option_new', fields, config);
  }

  async deleteCatalogVariable(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.deleteRecord(id, 'item_option_new', config);
  }

  async reorderCatalogVariables(items: Array<{ id: string; order: number }>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const results: EnterpriseRecord[] = [];
    for (const item of items) {
      results.push(await this.patchRecord(item.id, 'item_option_new', { order: String(item.order) }, config));
    }
    return results;
  }

  /* --- 13C: Variable Set Management (item_option_new_set) --- */

  async listVariableSets(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'item_option_new_set' } as unknown as EnterpriseQueryOptions, config);
  }

  async createVariableSet(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'item_option_new_set' }, config);
  }

  async addVariableToSet(setId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, variable_set: setId, __table: 'item_option_new' }, config);
  }

  async attachVariableSet(catItemId: string, variableSetId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ __table: 'io_set_item', sc_cat_item: catItemId, variable_set: variableSetId }, config);
  }

  async detachVariableSet(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.deleteRecord(id, 'io_set_item', config);
  }

  /* --- 13D: Record Producer Management (sc_cat_item_producer) --- */

  async listRecordProducers(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sc_cat_item_producer' } as unknown as EnterpriseQueryOptions, config);
  }

  async createRecordProducer(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sc_cat_item_producer' }, config);
  }

  async updateRecordProducer(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sc_cat_item_producer', fields, config);
  }

  async deleteRecordProducer(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.deleteRecord(id, 'sc_cat_item_producer', config);
  }

  /* --- 13E: Flow Designer Management (sys_hub_flow) --- */

  async createFlowRecord(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_hub_flow' }, config);
  }

  async updateFlowRecord(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_hub_flow', fields, config);
  }

  async activateFlow(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_hub_flow', { active: 'true' }, config);
  }

  async deactivateFlow(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_hub_flow', { active: 'false' }, config);
  }

  async getFlowDefinition(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'sys_hub_flow');
  }

  async addFlowAction(flowId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, flow: flowId, __table: 'sys_hub_action_instance' }, config);
  }

  async removeFlowAction(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.deleteRecord(id, 'sys_hub_action_instance', config);
  }

  async listSubflows(config: EnterpriseConnectorConfig, query = ''): Promise<EnterpriseRecord[]> {
    return this.query({ query: query || 'active=true^type=subflow', limit: 100, table: 'sys_hub_flow' } as unknown as EnterpriseQueryOptions, config);
  }

  async createSubflow(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, type: 'subflow', __table: 'sys_hub_flow' }, config);
  }

  /* --- 13F: Notification Management (sysevent_email_action) --- */

  async listNotifications(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sysevent_email_action' } as unknown as EnterpriseQueryOptions, config);
  }

  async createNotification(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sysevent_email_action' }, config);
  }

  async updateNotification(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sysevent_email_action', fields, config);
  }

  async deleteNotification(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.deleteRecord(id, 'sysevent_email_action', config);
  }

  async testNotification(id: string, recipientEmail: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ result: Record<string, unknown> }>(
      apiUrl(config, `/api/now/email/test`), this.authHeaders(config),
      JSON.stringify({ notification: id, recipients: recipientEmail }));
    return toRecord('notification_test', d.result, id);
  }

  /* --- 13G: Business Rule Management (sys_script) --- */

  async listBusinessRules(config: EnterpriseConnectorConfig, tableName = '', query = '', limit = 50): Promise<EnterpriseRecord[]> {
    const q = tableName ? `collection=${tableName}${query ? '^' + query : ''}` : query;
    return this.query({ query: q, limit, table: 'sys_script' } as unknown as EnterpriseQueryOptions, config);
  }

  async createBusinessRule(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_script' }, config);
  }

  async updateBusinessRule(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_script', fields, config);
  }

  async toggleBusinessRule(id: string, active: boolean, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_script', { active: active ? 'true' : 'false' }, config);
  }

  /* --- 13H: Client Script Management (sys_script_client) --- */

  async listClientScripts(config: EnterpriseConnectorConfig, tableName = '', query = '', limit = 50): Promise<EnterpriseRecord[]> {
    const q = tableName ? `table=${tableName}${query ? '^' + query : ''}` : query;
    return this.query({ query: q, limit, table: 'sys_script_client' } as unknown as EnterpriseQueryOptions, config);
  }

  async createClientScript(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_script_client' }, config);
  }

  async updateClientScript(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_script_client', fields, config);
  }

  async toggleClientScript(id: string, active: boolean, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_script_client', { active: active ? 'true' : 'false' }, config);
  }

  /* --- 13I: UI Policy Management (sys_ui_policy) --- */

  async listUIPolicies(config: EnterpriseConnectorConfig, tableName = '', query = '', limit = 50): Promise<EnterpriseRecord[]> {
    const q = tableName ? `table=${tableName}${query ? '^' + query : ''}` : query;
    return this.query({ query: q, limit, table: 'sys_ui_policy' } as unknown as EnterpriseQueryOptions, config);
  }

  async createUIPolicy(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_ui_policy' }, config);
  }

  async updateUIPolicy(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_ui_policy', fields, config);
  }

  async addUIPolicyAction(policyId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, ui_policy: policyId, __table: 'sys_ui_policy_action' }, config);
  }

  async toggleUIPolicy(id: string, active: boolean, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_ui_policy', { active: active ? 'true' : 'false' }, config);
  }

  /* --- 13J: Data Policy Management (sys_data_policy2) --- */

  async listDataPolicies(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_data_policy2' } as unknown as EnterpriseQueryOptions, config);
  }

  async createDataPolicy(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_data_policy2' }, config);
  }

  async updateDataPolicy(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_data_policy2', fields, config);
  }

  /* --- 13K: Script Include Management (sys_script_include) --- */

  async listScriptIncludes(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_script_include' } as unknown as EnterpriseQueryOptions, config);
  }

  async createScriptInclude(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_script_include' }, config);
  }

  async updateScriptInclude(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_script_include', fields, config);
  }

  /* --- 13L: Scheduled Script Execution (sysauto_script) --- */

  async listScheduledScripts(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sysauto_script' } as unknown as EnterpriseQueryOptions, config);
  }

  async createScheduledScript(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sysauto_script' }, config);
  }

  async updateScheduledScript(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sysauto_script', fields, config);
  }

  async toggleScheduledScript(id: string, active: boolean, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sysauto_script', { active: active ? 'true' : 'false' }, config);
  }

  /* --- 13M: UI Action Management (sys_ui_action) --- */

  async listUIActions(config: EnterpriseConnectorConfig, tableName = '', query = '', limit = 50): Promise<EnterpriseRecord[]> {
    const q = tableName ? `table=${tableName}${query ? '^' + query : ''}` : query;
    return this.query({ query: q, limit, table: 'sys_ui_action' } as unknown as EnterpriseQueryOptions, config);
  }

  async createUIAction(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_ui_action' }, config);
  }

  async updateUIAction(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_ui_action', fields, config);
  }

  async toggleUIAction(id: string, active: boolean, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_ui_action', { active: active ? 'true' : 'false' }, config);
  }

  /* --- 13N: Workflow Management (wf_workflow) --- */

  async listWorkflows(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'wf_workflow' } as unknown as EnterpriseQueryOptions, config);
  }

  async getWorkflow(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    return this.get(id, config, 'wf_workflow');
  }

  async createWorkflow(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'wf_workflow' }, config);
  }

  async publishWorkflow(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'wf_workflow', { published: 'true' }, config);
  }

  /* --- 13O: Approval Rule Management (sysrule_approvals) --- */

  async listApprovalRules(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sysrule_approvals' } as unknown as EnterpriseQueryOptions, config);
  }

  async createApprovalRule(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sysrule_approvals' }, config);
  }

  async updateApprovalRule(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sysrule_approvals', fields, config);
  }

  /* --- 13P: Assignment Rule Management (sysrule_assignment) --- */

  async listAssignmentRules(config: EnterpriseConnectorConfig, tableName = '', query = '', limit = 50): Promise<EnterpriseRecord[]> {
    const q = tableName ? `table=${tableName}${query ? '^' + query : ''}` : query;
    return this.query({ query: q, limit, table: 'sysrule_assignment' } as unknown as EnterpriseQueryOptions, config);
  }

  async createAssignmentRule(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sysrule_assignment' }, config);
  }

  async updateAssignmentRule(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sysrule_assignment', fields, config);
  }

  /* --- 13Q: SLA Definition Management (contract_sla) --- */

  async listSLADefinitions(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'contract_sla' } as unknown as EnterpriseQueryOptions, config);
  }

  async createSLADefinition(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'contract_sla' }, config);
  }

  async updateSLADefinition(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'contract_sla', fields, config);
  }

  /* --- 13R: Inbound Email Action (sysevent_in_email_action) --- */

  async listInboundEmailActions(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sysevent_in_email_action' } as unknown as EnterpriseQueryOptions, config);
  }

  async createInboundEmailAction(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sysevent_in_email_action' }, config);
  }

  async updateInboundEmailAction(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sysevent_in_email_action', fields, config);
  }

  /* --- 13S: Dictionary & Schema Management --- */

  async listTables(config: EnterpriseConnectorConfig, query = '', limit = 100): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_db_object' } as unknown as EnterpriseQueryOptions, config);
  }

  async getTableSchema(tableName: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `name=${tableName}`, limit: 500, table: 'sys_dictionary' } as unknown as EnterpriseQueryOptions, config);
  }

  async createTableRecord(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_db_object' }, config);
  }

  async addColumn(tableName: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, name: tableName, __table: 'sys_dictionary' }, config);
  }

  async updateColumn(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_dictionary', fields, config);
  }

  async listChoices(tableName: string, element: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    return this.query({ query: `name=${tableName}^element=${element}`, limit: 200, table: 'sys_choice' } as unknown as EnterpriseQueryOptions, config);
  }

  async addChoice(tableName: string, element: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, name: tableName, element, __table: 'sys_choice' }, config);
  }

  async updateChoice(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_choice', fields, config);
  }

  /* --- 13T: Application Scope & Module Management --- */

  async listAppScopes(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_scope' } as unknown as EnterpriseQueryOptions, config);
  }

  async createAppScope(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_scope' }, config);
  }

  async listModules(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sys_app_module' } as unknown as EnterpriseQueryOptions, config);
  }

  async createModule(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sys_app_module' }, config);
  }

  async updateModule(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sys_app_module', fields, config);
  }

  /* --- 13U: Service Portal --- */

  async listPortalPages(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sp_page' } as unknown as EnterpriseQueryOptions, config);
  }

  async createPortalPage(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sp_page' }, config);
  }

  async listWidgets(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'sp_widget' } as unknown as EnterpriseQueryOptions, config);
  }

  async createWidget(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'sp_widget' }, config);
  }

  async updateWidget(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'sp_widget', fields, config);
  }

  /* --- 13V: Knowledge Management Configuration --- */

  async listKnowledgeBases(config: EnterpriseConnectorConfig, query = '', limit = 50): Promise<EnterpriseRecord[]> {
    return this.query({ query, limit, table: 'kb_knowledge_base' } as unknown as EnterpriseQueryOptions, config);
  }

  async createKnowledgeBase(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'kb_knowledge_base' }, config);
  }

  async createKnowledgeArticle(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.create({ ...data, __table: 'kb_knowledge' }, config);
  }

  async updateKnowledgeArticle(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'kb_knowledge', fields, config);
  }

  async publishKnowledgeArticle(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'kb_knowledge', { workflow_state: 'published' }, config);
  }

  async retireKnowledgeArticle(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    return this.patchRecord(id, 'kb_knowledge', { workflow_state: 'retired' }, config);
  }

  /* ================================================================
   *  HTTP helpers
   * ================================================================ */

  protected async fetchWithBody(method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ result: Record<string, unknown> }> {
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body,
    });
    if (!resp.ok) throw new Error(`servicenow: ${method} HTTP ${resp.status}`);
    return resp.json() as Promise<{ result: Record<string, unknown> }>;
  }

  protected async fetchRaw(method: string, url: string, headers: Record<string, string>): Promise<void> {
    const resp = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
    });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`servicenow: ${method} HTTP ${resp.status}`);
    }
  }
}
