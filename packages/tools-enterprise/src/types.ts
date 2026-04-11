/**
 * Types for enterprise connector tools
 */

export interface EnterpriseConnectorConfig {
  name: string;
  type: string;
  enabled: boolean;
  baseUrl: string;
  authType: 'oauth2' | 'api_key' | 'bearer' | 'basic' | 'service_account';
  authConfig: Record<string, string>;
  scopes?: string[];
  options?: Record<string, string>;
}

export interface EnterpriseRecord {
  id: string;
  type: string;
  source: string;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface EnterpriseQueryOptions {
  query: string;
  limit?: number;
  filters?: Record<string, unknown>;
}

export interface EnterpriseProvider {
  readonly type: string;
  query(options: EnterpriseQueryOptions, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]>;
  get(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null>;
  create(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord>;
}
