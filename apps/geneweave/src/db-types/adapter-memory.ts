import type { SemanticMemoryRow, EntityMemoryRow, MemoryExtractionEventRow, WebsiteCredentialRow, SSOLinkedAccountRow } from './memory.js';

export interface IMemoryStore {
  // Website Credentials
  createWebsiteCredential(c: Omit<WebsiteCredentialRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWebsiteCredential(id: string, userId: string): Promise<WebsiteCredentialRow | null>;
  listWebsiteCredentials(userId: string): Promise<WebsiteCredentialRow[]>;
  listAllActiveWebsiteCredentials(): Promise<WebsiteCredentialRow[]>;
  findWebsiteCredential(userId: string, url: string): Promise<WebsiteCredentialRow | null>;
  updateWebsiteCredential(id: string, userId: string, fields: Partial<Omit<WebsiteCredentialRow, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWebsiteCredential(id: string, userId: string): Promise<void>;

  // SSO Linked Accounts
  createSSOLinkedAccount(acct: { id: string; user_id: string; identity_provider: string; email?: string; session_encrypted: string; encryption_iv: string }): Promise<void>;
  getSSOLinkedAccount(userId: string, identityProvider: string): Promise<SSOLinkedAccountRow | null>;
  listSSOLinkedAccounts(userId: string): Promise<Array<Omit<SSOLinkedAccountRow, 'session_encrypted' | 'encryption_iv'>>>;
  deleteSSOLinkedAccount(userId: string, identityProvider: string): Promise<void>;

  // Semantic Memory
  saveSemanticMemory(m: { id: string; userId: string; chatId?: string; tenantId?: string; content: string; memoryType?: string; source?: string }): Promise<void>;
  searchSemanticMemory(opts: { userId: string; query: string; limit?: number }): Promise<SemanticMemoryRow[]>;
  listSemanticMemory(userId: string, limit?: number): Promise<SemanticMemoryRow[]>;
  deleteSemanticMemory(id: string, userId: string): Promise<void>;
  clearUserSemanticMemory(userId: string): Promise<void>;

  // Entity Memory
  upsertEntity(e: { userId: string; entityName: string; entityType?: string; facts: Record<string, unknown>; confidence?: number; source?: string; chatId?: string; tenantId?: string }): Promise<void>;
  getEntity(userId: string, entityName: string): Promise<EntityMemoryRow | null>;
  searchEntities(userId: string, query: string): Promise<EntityMemoryRow[]>;
  listEntities(userId: string): Promise<EntityMemoryRow[]>;
  deleteEntity(userId: string, entityName: string): Promise<void>;
  clearUserEntityMemory(userId: string): Promise<void>;
  recordMemoryExtractionEvent(e: { id: string; userId: string; chatId?: string; tenantId?: string; selfDisclosure: boolean; regexEntitiesCount: number; llmEntitiesCount: number; mergedEntitiesCount: number; events?: string }): Promise<void>;
  getMemoryExtractionEvent(id: string): Promise<MemoryExtractionEventRow | null>;
  listMemoryExtractionEvents(chatId?: string, limit?: number): Promise<MemoryExtractionEventRow[]>;
}
