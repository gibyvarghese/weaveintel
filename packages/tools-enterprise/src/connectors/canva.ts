/**
 * Canva Connect API — Full connector
 *
 * Covers: Designs (list, get, create, export), Assets (upload, list, get, delete),
 * Folders (CRUD), Comments (list, add, reply), Brand Templates, Users.
 *
 * Base URL: https://api.canva.com/rest/v1
 * Auth: OAuth 2.0 (Authorization Code)
 *
 * @see https://www.canva.dev/docs/connect/
 */
import { BaseEnterpriseProvider } from '../base.js';
import type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions } from '../types.js';

function api(config: EnterpriseConnectorConfig, path: string): string {
  const b = config.baseUrl ?? 'https://api.canva.com/rest/v1';
  return `${b}${path}`;
}

function toRecord(type: string, data: Record<string, unknown>, id?: string): EnterpriseRecord {
  return { id: String(id ?? data['id'] ?? ''), type, source: 'canva', data };
}

export class CanvaProvider extends BaseEnterpriseProvider {
  readonly type = 'canva';

  /* ===== Search / List Designs ===== */

  async query(options: EnterpriseQueryOptions, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const params = new URLSearchParams({ query: options.query, limit: String(options.limit ?? 25) });
    const d = await this.fetchJSON<{ items: Array<Record<string, unknown>> }>(
      api(config, `/designs?${params}`), this.authHeaders(config));
    return (d.items ?? []).map(i => toRecord('design', i));
  }

  async get(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<Record<string, unknown>>(
        api(config, `/designs/${id}`), this.authHeaders(config));
      return toRecord('design', d);
    } catch { return null; }
  }

  async create(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<Record<string, unknown>>(
      api(config, '/designs'), this.authHeaders(config), JSON.stringify(data));
    return toRecord('design', d);
  }

  /* ===== Designs (extended) ===== */

  async listDesigns(config: EnterpriseConnectorConfig, limit = 25, continuation?: string): Promise<{ items: EnterpriseRecord[]; continuation?: string }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (continuation) params.set('continuation', continuation);
    const d = await this.fetchJSON<{ items: Array<Record<string, unknown>>; continuation?: string }>(
      api(config, `/designs?${params}`), this.authHeaders(config));
    return { items: (d.items ?? []).map(i => toRecord('design', i)), continuation: d.continuation };
  }

  /* ===== Export ===== */

  async createExport(designId: string, format: 'pdf' | 'png' | 'jpg' | 'pptx' | 'mp4' | 'gif', config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<Record<string, unknown>>(
      api(config, `/exports`), this.authHeaders(config), JSON.stringify({ design_id: designId, format }));
    return toRecord('export', d);
  }

  async getExport(exportId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<Record<string, unknown>>(
        api(config, `/exports/${exportId}`), this.authHeaders(config));
      return toRecord('export', d);
    } catch { return null; }
  }

  /* ===== Assets ===== */

  async listAssets(config: EnterpriseConnectorConfig, limit = 25, continuation?: string): Promise<{ items: EnterpriseRecord[]; continuation?: string }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (continuation) params.set('continuation', continuation);
    const d = await this.fetchJSON<{ items: Array<Record<string, unknown>>; continuation?: string }>(
      api(config, `/assets?${params}`), this.authHeaders(config));
    return { items: (d.items ?? []).map(i => toRecord('asset', i)), continuation: d.continuation };
  }

  async getAsset(assetId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<Record<string, unknown>>(
        api(config, `/assets/${assetId}`), this.authHeaders(config));
      return toRecord('asset', d);
    } catch { return null; }
  }

  async uploadAsset(name: string, url: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<Record<string, unknown>>(
      api(config, '/assets/upload'), this.authHeaders(config), JSON.stringify({ name, url }));
    return toRecord('asset', d);
  }

  async deleteAsset(assetId: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchRaw('DELETE', api(config, `/assets/${assetId}`), this.authHeaders(config));
  }

  /* ===== Folders ===== */

  async listFolders(config: EnterpriseConnectorConfig, limit = 25, continuation?: string): Promise<{ items: EnterpriseRecord[]; continuation?: string }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (continuation) params.set('continuation', continuation);
    const d = await this.fetchJSON<{ items: Array<Record<string, unknown>>; continuation?: string }>(
      api(config, `/folders?${params}`), this.authHeaders(config));
    return { items: (d.items ?? []).map(i => toRecord('folder', i)), continuation: d.continuation };
  }

  async getFolder(folderId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<Record<string, unknown>>(
        api(config, `/folders/${folderId}`), this.authHeaders(config));
      return toRecord('folder', d);
    } catch { return null; }
  }

  async createFolder(name: string, parentFolderId?: string, config?: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const body: Record<string, unknown> = { name };
    if (parentFolderId) body['parent_folder_id'] = parentFolderId;
    const d = await this.fetchJSON<Record<string, unknown>>(
      api(config!, '/folders'), this.authHeaders(config!), JSON.stringify(body));
    return toRecord('folder', d);
  }

  async updateFolder(folderId: string, name: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchWithBody('PATCH', api(config, `/folders/${folderId}`), this.authHeaders(config), JSON.stringify({ name }));
    return toRecord('folder', d);
  }

  async deleteFolder(folderId: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchRaw('DELETE', api(config, `/folders/${folderId}`), this.authHeaders(config));
  }

  async moveFolderItem(itemId: string, fromFolder: string, toFolder: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchJSON(api(config, `/folders/${toFolder}/items`), this.authHeaders(config),
      JSON.stringify({ item_id: itemId, from_folder_id: fromFolder }));
  }

  /* ===== Comments ===== */

  async listComments(designId: string, config: EnterpriseConnectorConfig, limit = 25): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ items: Array<Record<string, unknown>> }>(
      api(config, `/designs/${designId}/comments?limit=${limit}`), this.authHeaders(config));
    return (d.items ?? []).map(c => toRecord('comment', c));
  }

  async addComment(designId: string, message: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<Record<string, unknown>>(
      api(config, `/designs/${designId}/comments`), this.authHeaders(config), JSON.stringify({ message }));
    return toRecord('comment', d);
  }

  async replyToComment(designId: string, commentId: string, message: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<Record<string, unknown>>(
      api(config, `/designs/${designId}/comments/${commentId}/replies`), this.authHeaders(config), JSON.stringify({ message }));
    return toRecord('comment', d);
  }

  /* ===== Brand Templates ===== */

  async listBrandTemplates(config: EnterpriseConnectorConfig, limit = 25): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ items: Array<Record<string, unknown>> }>(
      api(config, `/brand-templates?limit=${limit}`), this.authHeaders(config));
    return (d.items ?? []).map(t => toRecord('brand_template', t));
  }

  async getBrandTemplate(templateId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<Record<string, unknown>>(
        api(config, `/brand-templates/${templateId}`), this.authHeaders(config));
      return toRecord('brand_template', d);
    } catch { return null; }
  }

  /* ===== User ===== */

  async getUser(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<Record<string, unknown>>(api(config, '/users/me'), this.authHeaders(config));
    return toRecord('user', d);
  }

  /* ===== HTTP helpers ===== */

  protected async fetchWithBody(method: string, url: string, headers: Record<string, string>, body?: string): Promise<Record<string, unknown>> {
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    if (!resp.ok) throw new Error(`canva: ${method} ${resp.status} ${resp.statusText}`);
    return resp.json() as Promise<Record<string, unknown>>;
  }

  protected async fetchRaw(method: string, url: string, headers: Record<string, string>): Promise<void> {
    const resp = await fetch(url, { method, headers: { ...headers } });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`canva: ${method} ${resp.status} ${resp.statusText}`);
    }
  }
}
