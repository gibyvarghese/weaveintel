/**
 * GeneWeave — db-types/adapter-scopes.ts
 *
 * Database adapter methods for the scope isolation tables (m75).
 * Mixed into SQLiteAdapter via the adapter composition pattern used throughout geneweave.
 */
import { randomUUID } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  AgentScopeRow,
  ScopeCrossPolicyRow,
  ScopeAccessLogRow,
} from './scopes.js';

export interface ScopesAdapterMethods {
  /** List all enabled scope definitions. */
  listScopes(): Promise<AgentScopeRow[]>;

  /** Get a single scope by ID. Returns null if not found. */
  getScope(id: string): Promise<AgentScopeRow | null>;

  /** List all enabled cross-scope policies. */
  listScopePolicies(): Promise<ScopeCrossPolicyRow[]>;

  /** Returns the scope ID for a given skill ID, or 'system' if not assigned. */
  getScopeForSkill(skillId: string): Promise<string>;

  /** Returns the scope ID for a given live agent mesh + role, or 'system' if not assigned. */
  getScopeForMeshRole(meshKey: string, roleKey: string): Promise<string>;

  /**
   * Appends a row to the immutable scope_access_log.
   * Never call UPDATE or DELETE on this table.
   */
  logScopeEvent(event: Omit<ScopeAccessLogRow, 'id' | 'created_at'>): Promise<void>;

  /** Returns recent scope access log entries (most recent first). */
  listScopeAccessLog(opts?: {
    limit?: number;
    sessionId?: string;
    onlyViolations?: boolean;
  }): Promise<ScopeAccessLogRow[]>;

  /** Returns the count of scope violations in the last N hours. */
  countScopeViolations(withinHours?: number): Promise<number>;
}

/**
 * Builds the adapter methods. Call this from the SQLiteAdapter class body,
 * passing `this.raw` (the BetterSqlite3.Database instance).
 */
export function buildScopesAdapter(raw: BetterSqlite3.Database): ScopesAdapterMethods {
  return {
    async listScopes(): Promise<AgentScopeRow[]> {
      return raw.prepare(`
        SELECT * FROM agent_scopes WHERE enabled = 1 ORDER BY id
      `).all() as AgentScopeRow[];
    },

    async getScope(id: string): Promise<AgentScopeRow | null> {
      return (raw.prepare(`
        SELECT * FROM agent_scopes WHERE id = ?
      `).get(id) as AgentScopeRow | undefined) ?? null;
    },

    async listScopePolicies(): Promise<ScopeCrossPolicyRow[]> {
      return raw.prepare(`
        SELECT * FROM scope_cross_policies WHERE enabled = 1
        ORDER BY from_scope, to_scope
      `).all() as ScopeCrossPolicyRow[];
    },

    async getScopeForSkill(skillId: string): Promise<string> {
      // First try the skill-level override in scope_skill_assignments
      const row = raw.prepare(`
        SELECT scope_id FROM scope_skill_assignments WHERE skill_id = ?
      `).get(skillId) as { scope_id: string } | undefined;
      if (row) return row.scope_id;

      // Then try the agentic_scope column on a2a_skills
      const skillRow = raw.prepare(`
        SELECT agentic_scope FROM a2a_skills WHERE id = ?
      `).get(skillId) as { agentic_scope: string } | undefined;
      if (skillRow?.agentic_scope) return skillRow.agentic_scope;

      // Default: 'system' (most permissive, treated as a shared utility scope)
      return 'system';
    },

    async getScopeForMeshRole(meshKey: string, roleKey: string): Promise<string> {
      // Check for specific role assignment first, fall back to catch-all ('' role_key)
      const row = raw.prepare(`
        SELECT scope_id FROM scope_live_agent_assignments
        WHERE mesh_key = ? AND role_key IN (?, '')
        ORDER BY CASE role_key WHEN ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(meshKey, roleKey, roleKey) as { scope_id: string } | undefined;
      return row?.scope_id ?? 'system';
    },

    async logScopeEvent(event: Omit<ScopeAccessLogRow, 'id' | 'created_at'>): Promise<void> {
      const id = randomUUID();
      raw.prepare(`
        INSERT INTO scope_access_log
          (id, event_type, from_scope, to_scope, skill_id, tool_name,
           session_id, task_id, user_id, allowed, reason, delegation_chain_json)
        VALUES
          (@id, @event_type, @from_scope, @to_scope, @skill_id, @tool_name,
           @session_id, @task_id, @user_id, @allowed, @reason, @delegation_chain_json)
      `).run({ id, ...event });
    },

    async listScopeAccessLog(opts = {}): Promise<ScopeAccessLogRow[]> {
      const limit = opts.limit ?? 100;
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (opts.sessionId) {
        conditions.push('session_id = ?');
        params.push(opts.sessionId);
      }
      if (opts.onlyViolations) {
        conditions.push('allowed = 0');
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);

      return raw.prepare(`
        SELECT * FROM scope_access_log ${where} ORDER BY created_at DESC LIMIT ?
      `).all(...params) as ScopeAccessLogRow[];
    },

    async countScopeViolations(withinHours = 24): Promise<number> {
      const since = new Date(Date.now() - withinHours * 3600 * 1000).toISOString();
      const row = raw.prepare(`
        SELECT COUNT(*) as n FROM scope_access_log
        WHERE allowed = 0 AND created_at >= ?
      `).get(since) as { n: number };
      return row.n;
    },
  };
}
