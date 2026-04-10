/**
 * @weaveintel/core — Connector contracts
 *
 * Why: Connectors are how external data enters the system. A stable connector
 * interface means any data source — file, DB, SaaS, email — plugs in identically.
 * Capability-based: a connector declares what it can do (list, read, search, watch).
 */

import type { CapabilityId, HasCapabilities } from './capabilities.js';
import type { ExecutionContext } from './context.js';
import type { Document, DocumentMetadata } from './documents.js';

export interface ConnectorConfig {
  readonly name: string;
  readonly type: string;
  readonly auth?: ConnectorAuth;
  readonly options?: Record<string, unknown>;
}

export type ConnectorAuth =
  | { readonly type: 'api_key'; readonly key: string }
  | { readonly type: 'oauth2'; readonly accessToken: string; readonly refreshToken?: string }
  | { readonly type: 'basic'; readonly username: string; readonly password: string }
  | { readonly type: 'bearer'; readonly token: string }
  | { readonly type: 'custom'; readonly credentials: Record<string, string> };

export interface ConnectorListOptions {
  readonly path?: string;
  readonly filter?: Record<string, unknown>;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ConnectorListResult {
  readonly items: readonly ConnectorListItem[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface ConnectorListItem {
  readonly id: string;
  readonly name: string;
  readonly type: 'file' | 'folder' | 'record' | 'page' | 'message' | 'other';
  readonly metadata?: DocumentMetadata;
}

export interface ConnectorReadOptions {
  readonly id: string;
  readonly format?: 'text' | 'html' | 'markdown' | 'raw';
}

export interface ConnectorSearchOptions {
  readonly query: string;
  readonly limit?: number;
  readonly filter?: Record<string, unknown>;
}

export interface ConnectorWatchEvent {
  readonly type: 'created' | 'updated' | 'deleted';
  readonly itemId: string;
  readonly timestamp: string;
  readonly metadata?: DocumentMetadata;
}

/** Base connector interface — every connector implements this */
export interface Connector extends HasCapabilities {
  readonly config: ConnectorConfig;

  initialize?(ctx: ExecutionContext): Promise<void>;
  shutdown?(): Promise<void>;

  /** Test that the connector can authenticate and reach its data source */
  healthCheck?(ctx: ExecutionContext): Promise<{ ok: boolean; message?: string }>;
}

/** Connector that can list items */
export interface ListableConnector extends Connector {
  list(ctx: ExecutionContext, options?: ConnectorListOptions): Promise<ConnectorListResult>;
}

/** Connector that can read individual items */
export interface ReadableConnector extends Connector {
  read(ctx: ExecutionContext, options: ConnectorReadOptions): Promise<Document>;
}

/** Connector that can search items */
export interface SearchableConnector extends Connector {
  search(ctx: ExecutionContext, options: ConnectorSearchOptions): Promise<Document[]>;
}

/** Connector that can watch for real-time changes */
export interface WatchableConnector extends Connector {
  watch(
    ctx: ExecutionContext,
    callback: (event: ConnectorWatchEvent) => void,
  ): Promise<{ stop: () => void }>;
}

/** Connector that supports incremental sync */
export interface SyncableConnector extends Connector {
  sync(
    ctx: ExecutionContext,
    cursor?: string,
  ): AsyncIterable<{ document: Document; cursor: string }>;
}

/** Type guard helpers */
export function isListable(c: Connector): c is ListableConnector {
  return 'list' in c && typeof (c as ListableConnector).list === 'function';
}

export function isReadable(c: Connector): c is ReadableConnector {
  return 'read' in c && typeof (c as ReadableConnector).read === 'function';
}

export function isSearchable(c: Connector): c is SearchableConnector {
  return 'search' in c && typeof (c as SearchableConnector).search === 'function';
}

export function isWatchable(c: Connector): c is WatchableConnector {
  return 'watch' in c && typeof (c as WatchableConnector).watch === 'function';
}

export function isSyncable(c: Connector): c is SyncableConnector {
  return 'sync' in c && typeof (c as SyncableConnector).sync === 'function';
}
