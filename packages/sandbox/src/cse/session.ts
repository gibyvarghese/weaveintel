/**
 * @weaveintel/sandbox/cse — Session manager
 *
 * Manages the lifecycle of persistent container sessions tied to chat IDs.
 * Sessions are reused across multiple turns in the same chat, enabling
 * stateful computation (variables, installed packages, loaded data persist).
 *
 * Sessions expire after CSE_SESSION_TTL_MS (default 10 min) of inactivity
 * and are cleaned up both proactively (background sweep) and on demand.
 */

import type { CSEConfig, CSESession, SessionStatus } from './types.js';
import type { ContainerProvider } from './providers/base.js';

export class SessionManager {
  private sessions = new Map<string, CSESession>();
  private affinityToSession = new Map<string, string>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly ttlMs: number = 10 * 60_000) {}

  /** Start background sweep to evict expired sessions. */
  startSweep(provider: ContainerProvider, config: CSEConfig): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.evictExpired(provider, config);
    }, 60_000);
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** Get or create a session for the given chat. */
  async getOrCreateSession(
    userId: string | undefined,
    chatId: string,
    provider: ContainerProvider,
    config: CSEConfig,
    withBrowser: boolean,
  ): Promise<CSESession> {
    const affinityKey = this.affinityKey(userId, chatId);
    const existingId = this.affinityToSession.get(affinityKey);
    if (existingId) {
      const session = this.sessions.get(existingId);
      if (session && session.status !== 'terminated' && session.status !== 'error') {
        return session;
      }
      // Stale entry — remove and create fresh
      this.sessions.delete(existingId);
      this.affinityToSession.delete(affinityKey);
    }

    const maxSessions = config.maxSessions ?? 20;
    if (this.sessions.size >= maxSessions) {
      // Evict the least recently used session
      await this.evictLRU(provider, config);
    }

    const session = await provider.createSession(chatId, config, withBrowser);
    session.userId = userId;
    session.chatId = chatId;
    this.sessions.set(session.sessionId, session);
    this.affinityToSession.set(affinityKey, session.sessionId);
    return session;
  }

  /** Get a session by ID (for explicit session reuse). */
  getSession(sessionId: string): CSESession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Mark session as busy / ready and update lastUsedAt. */
  markBusy(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.status = 'busy'; s.lastUsedAt = Date.now(); }
  }

  markReady(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.status = 'ready'; s.lastUsedAt = Date.now(); s.executionCount++; }
  }

  markError(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.status = 'error';
  }

  /** Explicitly terminate a session. */
  async terminateSession(
    sessionId: string,
    provider: ContainerProvider,
    config: CSEConfig,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = 'terminated';
    await provider.terminateSession(session, config).catch(() => {});
    this.sessions.delete(sessionId);
    if (session.chatId) this.affinityToSession.delete(this.affinityKey(session.userId, session.chatId));
  }

  /** Terminate the session for a specific chat. */
  async terminateChatSession(
    userId: string | undefined,
    chatId: string,
    provider: ContainerProvider,
    config: CSEConfig,
  ): Promise<void> {
    const sessionId = this.affinityToSession.get(this.affinityKey(userId, chatId));
    if (sessionId) await this.terminateSession(sessionId, provider, config);
  }

  /** Return summary of active sessions (no sensitive details). */
  listSessions(): Array<{
    sessionId: string;
    userId?: string;
    chatId?: string;
    status: SessionStatus;
    hasBrowser: boolean;
    executionCount: number;
    idleSec: number;
  }> {
    const now = Date.now();
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      userId: s.userId,
      chatId: s.chatId,
      status: s.status,
      hasBrowser: s.hasBrowser,
      executionCount: s.executionCount,
      idleSec: Math.round((now - s.lastUsedAt) / 1_000),
    }));
  }

  private affinityKey(userId: string | undefined, chatId: string): string {
    return `${userId ?? 'anonymous'}::${chatId}`;
  }

  private async evictExpired(provider: ContainerProvider, config: CSEConfig): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.status === 'terminated') { this.sessions.delete(id); continue; }
      if (now - session.lastUsedAt > this.ttlMs) {
        await this.terminateSession(id, provider, config);
      }
    }
  }

  private async evictLRU(provider: ContainerProvider, config: CSEConfig): Promise<void> {
    let oldest: CSESession | undefined;
    for (const session of this.sessions.values()) {
      if (session.status === 'busy') continue;
      if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
    }
    if (oldest) await this.terminateSession(oldest.sessionId, provider, config);
  }
}
