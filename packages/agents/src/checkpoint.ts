/**
 * @weaveintel/agents — P5-1: Agent checkpoint / resume
 *
 * Defines the checkpoint data model and store interface so agent runs can be
 * saved at regular intervals and resumed across process boundaries.
 *
 * Two built-in store implementations are provided:
 *   - `InMemoryCheckpointStore` — for tests and single-process usage
 *   - `createSQLiteCheckpointStore(path)` — for durable cross-process resume
 *
 * Usage:
 * ```ts
 * import { InMemoryCheckpointStore, resumeFromCheckpoint } from '@weaveintel/agents';
 *
 * const store = new InMemoryCheckpointStore();
 *
 * // Run agent with checkpointing (saves every 2 steps)
 * const agent = weaveAgent({ model, checkpoint: { store, intervalSteps: 2 } });
 * const result = await agent.run(ctx, input);
 *
 * // Resume from last checkpoint after a process crash
 * const resumed = resumeFromCheckpoint(checkpoint, { model, ...opts });
 * const final = await resumed.run(ctx, { messages: [], goal: input.goal });
 * ```
 */

import { createRequire } from 'node:module';
import type { Message } from '@weaveintel/core';
import type { AgentStep, AgentResult } from '@weaveintel/core';

const requireCjs = createRequire(import.meta.url);

// ─── Data model ───────────────────────────────────────────────

/**
 * A snapshot of an agent run taken at a specific step.
 * Can be serialised to JSON and stored in any key-value backend.
 */
export interface AgentCheckpoint {
  /** Stable identifier for this run (caller-supplied or auto-generated). */
  runId: string;
  /** Agent name as set in `ToolCallingAgentOptions.name`. */
  agentName: string;
  /**
   * The step index at which this snapshot was taken.
   * On resume, the agent re-enters the loop at exactly this position.
   */
  stepIndex: number;
  /** Full conversation history at the time of the snapshot (includes system msg). */
  messages: Message[];
  /** Steps completed so far — injected as prior history on resume. */
  steps: AgentStep[];
  /** Token budget consumed to date. */
  tokenCounts: {
    prompt: number;
    completion: number;
  };
  /** W1 revision counter at time of snapshot. */
  revisionCount: number;
  /** W2 verify attempt counter at time of snapshot. */
  verifyAttemptCount: number;
  /** P2-2 structured-output retry counter at time of snapshot. */
  structuredOutputRetryCount: number;
  /** Total tool invocations to date. */
  toolCallCount: number;
  /** ISO-8601 timestamp when the checkpoint was written. */
  createdAt: string;
  /** Set on the final checkpoint when the run reaches a terminal state. */
  completedAt?: string;
  /** Terminal status — only present on the final checkpoint. */
  status?: AgentResult['status'];
}

// ─── Store interface ──────────────────────────────────────────

/**
 * Minimal async key-value interface for checkpoint persistence.
 * Implement this to use any backend (DynamoDB, Redis, Postgres, etc.).
 */
export interface CheckpointStore {
  /** Persist a checkpoint. Overwrites any existing entry for `runId`. */
  save(runId: string, checkpoint: AgentCheckpoint): Promise<void>;
  /** Retrieve the latest checkpoint for a run, or `null` if not found. */
  load(runId: string): Promise<AgentCheckpoint | null>;
  /**
   * List all saved checkpoints for a given agent name.
   * Returned in descending creation order (newest first).
   */
  list(agentName: string): Promise<AgentCheckpoint[]>;
  /** Remove a checkpoint. No-op if not found. */
  delete(runId: string): Promise<void>;
}

// ─── In-memory store ──────────────────────────────────────────

/**
 * Ephemeral in-process store. Suitable for tests and single-request scenarios.
 * All data is lost when the process exits.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly _checkpoints = new Map<string, AgentCheckpoint>();

  async save(runId: string, checkpoint: AgentCheckpoint): Promise<void> {
    // Deep-copy to prevent mutation after save.
    this._checkpoints.set(runId, JSON.parse(JSON.stringify(checkpoint)) as AgentCheckpoint);
  }

  async load(runId: string): Promise<AgentCheckpoint | null> {
    return this._checkpoints.get(runId) ?? null;
  }

  async list(agentName: string): Promise<AgentCheckpoint[]> {
    return [...this._checkpoints.values()]
      .filter((c) => c.agentName === agentName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async delete(runId: string): Promise<void> {
    this._checkpoints.delete(runId);
  }

  /** For tests — number of stored checkpoints. */
  get size(): number {
    return this._checkpoints.size;
  }
}

// ─── SQLite store ─────────────────────────────────────────────

interface SqliteStmt {
  run(...args: unknown[]): { changes?: number };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
}

/**
 * Durable SQLite-backed checkpoint store. Uses `better-sqlite3` (lazy-loaded
 * so the agents package does not force the dep on apps that pick another
 * backend).
 *
 * Schema:
 * ```sql
 * CREATE TABLE <table> (
 *   run_id      TEXT PRIMARY KEY,
 *   agent_name  TEXT NOT NULL,
 *   step_index  INTEGER NOT NULL,
 *   payload     TEXT NOT NULL,  -- full AgentCheckpoint as JSON
 *   created_at  TEXT NOT NULL
 * )
 * ```
 *
 * @param path  Filesystem path for the SQLite file; use `':memory:'` for tests.
 * @param table Table name (default: `agent_checkpoints`).
 */
export function createSQLiteCheckpointStore(
  path: string,
  table = 'agent_checkpoints',
): CheckpointStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = requireCjs('better-sqlite3') as new (p: string) => SqliteDb;
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      run_id      TEXT PRIMARY KEY,
      agent_name  TEXT NOT NULL,
      step_index  INTEGER NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cp_agent ON ${table}(agent_name);
  `);

  const stSave = db.prepare(
    `INSERT INTO ${table}(run_id,agent_name,step_index,payload,created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET
       agent_name=excluded.agent_name,
       step_index=excluded.step_index,
       payload=excluded.payload,
       created_at=excluded.created_at`,
  );
  const stLoad = db.prepare(`SELECT payload FROM ${table} WHERE run_id = ?`);
  const stList = db.prepare(`SELECT payload FROM ${table} WHERE agent_name = ? ORDER BY created_at DESC`);
  const stDelete = db.prepare(`DELETE FROM ${table} WHERE run_id = ?`);

  return {
    async save(runId, checkpoint) {
      stSave.run(
        runId,
        checkpoint.agentName,
        checkpoint.stepIndex,
        JSON.stringify(checkpoint),
        checkpoint.createdAt,
      );
    },
    async load(runId) {
      const row = stLoad.get(runId) as { payload: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.payload) as AgentCheckpoint;
    },
    async list(agentName) {
      const rows = stList.all(agentName) as { payload: string }[];
      return rows.map((r) => JSON.parse(r.payload) as AgentCheckpoint);
    },
    async delete(runId) {
      stDelete.run(runId);
    },
  };
}

// ─── Resume helper ────────────────────────────────────────────

/**
 * Options for `resumeFromCheckpoint` — mirrors the relevant subset of
 * `ToolCallingAgentOptions` without the parts that the checkpoint already
 * supplies (messages, steps, token counts, etc.).
 */
export interface ResumeOptions {
  /** How many messages from the checkpoint to strip from the front
   *  when the agent's system prompt is set (avoids double system message).
   *  Defaults to `1` when `systemPrompt` is supplied, otherwise `0`. */
  stripLeadingSystemMessages?: number;
}

/**
 * Generate a new unique run ID. Format: `<agentName>:<epoch-ms>:<random-6>`.
 */
export function generateRunId(agentName: string): string {
  return `${agentName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}
