/**
 * Types for HTTP tool operations
 */

export interface HttpEndpointConfig {
  name: string;
  baseUrl: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  authType?: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2';
  authConfig?: Record<string, string>;
  timeout?: number;
  retryCount?: number;
  retryDelayMs?: number;
  rateLimit?: { requestsPerMinute: number };
  bodyTemplate?: string;
  responseTransform?: string;
  allowedHosts?: string[];
  blockedHosts?: string[];
  allowPrivateNetwork?: boolean;
  maxResponseBytes?: number;
  enabled?: boolean;
}

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  timeout?: number;
  allowedHosts?: string[];
  blockedHosts?: string[];
  allowPrivateNetwork?: boolean;
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  latencyMs: number;
}
