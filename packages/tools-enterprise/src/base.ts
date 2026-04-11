/**
 * Base enterprise connector
 */
import type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions, EnterpriseProvider } from './types.js';

export abstract class BaseEnterpriseProvider implements EnterpriseProvider {
  abstract readonly type: string;
  abstract query(options: EnterpriseQueryOptions, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]>;
  abstract get(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null>;
  abstract create(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord>;

  protected authHeaders(config: EnterpriseConnectorConfig): Record<string, string> {
    switch (config.authType) {
      case 'bearer':
      case 'oauth2':
      case 'service_account':
        return { Authorization: `Bearer ${config.authConfig['accessToken'] ?? config.authConfig['apiKey'] ?? ''}` };
      case 'api_key':
        return { 'X-API-Key': config.authConfig['apiKey'] ?? '' };
      case 'basic': {
        const b64 = Buffer.from(`${config.authConfig['username'] ?? ''}:${config.authConfig['password'] ?? ''}`).toString('base64');
        return { Authorization: `Basic ${b64}` };
      }
      default:
        return {};
    }
  }

  protected async fetchJSON<T>(url: string, headers: Record<string, string>, body?: string): Promise<T> {
    const resp = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    if (!resp.ok) throw new Error(`${this.type}: ${resp.status} ${resp.statusText}`);
    return resp.json() as Promise<T>;
  }
}
