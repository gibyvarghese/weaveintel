/**
 * @weaveintel/sandbox/cse — ComputeSandboxEngine
 *
 * High-level façade that wires provider selection, session management,
 * and code execution into a single object. This is what callers use —
 * they should not interact with providers directly.
 *
 * Usage:
 *   const cse = await ComputeSandboxEngine.create();
 *   const result = await cse.run({ code: 'print("hello")', language: 'python' });
 */

import type { ContainerProvider } from './providers/base.js';
import { createProvider, buildCSEConfig } from './registry.js';
import { SessionManager } from './session.js';
import type {
  CSEConfig,
  CSEHealthStatus,
  CSEProviderKind,
  CSESession,
  ExecutionRequest,
  ExecutionResult,
} from './types.js';

export class ComputeSandboxEngine {
  private constructor(
    private readonly provider: ContainerProvider,
    private readonly config: CSEConfig,
    private readonly sessions: SessionManager,
  ) {}

  /**
   * Create and initialise a ComputeSandboxEngine.
   *
   * @param config Override specific config values. Missing values are
   *               auto-detected from environment variables.
   */
  static async create(config: Partial<CSEConfig> = {}): Promise<ComputeSandboxEngine> {
    const merged: CSEConfig = { ...buildCSEConfig(), ...config };
    const providerKind: CSEProviderKind = merged.provider ?? 'local';
    const provider = createProvider(providerKind);

    await provider.initialize(merged);

    const ttlMs = merged.sessionTtlMs ?? 10 * 60_000;
    const sessions = new SessionManager(ttlMs);

    if (provider.supportsSession) {
      sessions.startSweep(provider, merged);
    }

    return new ComputeSandboxEngine(provider, merged, sessions);
  }

  /** Execute code. Uses a session if chatId is provided and provider supports it. */
  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const effectiveConfig: CSEConfig = {
      ...this.config,
      networkAccess: request.networkAccess ?? this.config.networkAccess,
    };

    // Session path: chatId provided + provider supports sessions
    if (request.chatId && this.provider.supportsSession) {
      const session = await this.sessions.getOrCreateSession(
        request.userId,
        request.chatId,
        this.provider,
        effectiveConfig,
        request.withBrowser ?? false,
      );

      this.sessions.markBusy(session.sessionId);
      try {
        const result = await this.provider.executeInSession(session, request, effectiveConfig);
        this.sessions.markReady(session.sessionId);
        return { ...result, sessionId: session.sessionId };
      } catch (err) {
        this.sessions.markError(session.sessionId);
        throw err;
      }
    }

    // Explicit session ID provided
    if (request.sessionId) {
      const session = this.sessions.getSession(request.sessionId);
      if (!session) throw new Error(`Session ${request.sessionId} not found or expired`);
      if (request.userId && session.userId && session.userId !== request.userId) {
        throw new Error(`Session ${request.sessionId} does not belong to current user`);
      }
      this.sessions.markBusy(session.sessionId);
      try {
        const result = await this.provider.executeInSession(session, request, effectiveConfig);
        this.sessions.markReady(session.sessionId);
        return result;
      } catch (err) {
        this.sessions.markError(session.sessionId);
        throw err;
      }
    }

    // Ephemeral execution
    return this.provider.execute(request, effectiveConfig);
  }

  /** Create a named session (without immediately executing anything). */
  async createSession(chatId: string, withBrowser = false, userId?: string): Promise<CSESession> {
    if (!this.provider.supportsSession) {
      throw new Error(`Provider ${this.provider.kind} does not support persistent sessions`);
    }
    return this.sessions.getOrCreateSession(userId, chatId, this.provider, this.config, withBrowser);
  }

  /** Terminate the session for a chat. */
  async terminateChatSession(chatId: string, userId?: string): Promise<void> {
    await this.sessions.terminateChatSession(userId, chatId, this.provider, this.config);
  }

  /** Terminate a specific session by ID. */
  async terminateSession(sessionId: string): Promise<void> {
    await this.sessions.terminateSession(sessionId, this.provider, this.config);
  }

  /** List all active sessions. */
  listSessions() {
    return this.sessions.listSessions();
  }

  /** Provider health check. */
  async healthCheck(): Promise<CSEHealthStatus> {
    return this.provider.healthCheck(this.config);
  }

  get providerKind(): CSEProviderKind {
    return this.provider.kind;
  }

  get supportsSession(): boolean {
    return this.provider.supportsSession;
  }

  get supportsBrowser(): boolean {
    return this.provider.supportsBrowser;
  }

  /** Graceful shutdown — terminate all sessions. */
  async shutdown(): Promise<void> {
    this.sessions.stopSweep();
    const allSessions = this.sessions.listSessions();
    await Promise.all(
      allSessions.map((s) => this.sessions.terminateSession(s.sessionId, this.provider, this.config)),
    );
  }
}
