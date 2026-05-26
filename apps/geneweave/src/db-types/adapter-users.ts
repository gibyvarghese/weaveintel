import type { UserRow, SessionRow, OAuthLinkedAccountRow } from './core.js';
import type { IdempotencyRecordRow, OAuthFlowStateRow } from './agents.js';

export interface IUserStore {
  // Users
  createUser(user: { id: string; email: string; name: string; passwordHash: string; persona?: string; tenantId?: string | null; emailBidx?: string | null }): Promise<void>;
  getUserByEmail(email: string): Promise<UserRow | null>;
  getUserByEmailBidx(bidx: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;
  listUsers(): Promise<UserRow[]>;
  listUsersForBidxRebuild(limit: number, afterId: string | null): Promise<Array<{ id: string; email: string }>>;
  setUserEmailBidx(userId: string, bidx: string | null): Promise<void>;
  updateUser(userId: string, updates: { email?: string; name?: string; persona?: string; tenantId?: string | null; passwordHash?: string; emailBidx?: string | null }): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  updateUserPersona(userId: string, persona: string): Promise<void>;

  // Sessions
  createSession(session: { id: string; userId: string; csrfToken: string; expiresAt: string }): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  deleteSession(id: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;

  // Idempotency records
  createIdempotencyRecord(record: Omit<IdempotencyRecordRow, 'created_at'>): Promise<void>;
  getIdempotencyRecordByKey(key: string): Promise<IdempotencyRecordRow | null>;
  deleteExpiredIdempotencyRecords(nowIso?: string): Promise<void>;
  trimIdempotencyRecords(maxEntries: number): Promise<void>;
  clearIdempotencyRecords(): Promise<void>;

  // OAuth flow state
  createOAuthFlowState(state: Omit<OAuthFlowStateRow, 'created_at'>): Promise<void>;
  consumeOAuthFlowStateByKey(stateKey: string): Promise<OAuthFlowStateRow | null>;
  deleteOAuthFlowStateByKey(stateKey: string): Promise<void>;
  deleteExpiredOAuthFlowStates(nowIso?: string): Promise<void>;

  // OAuth Linked Accounts
  createOAuthLinkedAccount(account: Omit<OAuthLinkedAccountRow, 'linked_at'>): Promise<void>;
  getOAuthLinkedAccount(userId: string, provider: string): Promise<OAuthLinkedAccountRow | null>;
  getOAuthLinkedAccountByProviderUserId(provider: string, providerUserId: string): Promise<OAuthLinkedAccountRow | null>;
  listOAuthLinkedAccounts(userId: string): Promise<OAuthLinkedAccountRow[]>;
  updateOAuthAccountLastUsed(userId: string, provider: string): Promise<void>;
  deleteOAuthLinkedAccount(userId: string, provider: string): Promise<void>;
}
