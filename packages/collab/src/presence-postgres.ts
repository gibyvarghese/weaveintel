// SPDX-License-Identifier: MIT
import type { RunPresenceParticipant } from '@weaveintel/core';
import type { PresenceManager, PresenceScope } from './presence.js';

export interface PresenceSqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export interface PostgresPresenceOptions {
  readonly client: PresenceSqlClient;
  readonly schema: string;
  /** Unquoted lower-case PostgreSQL identifier, at most 52 characters. */
  readonly table: string;
  readonly ttlMs?: number;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid presence SQL identifier');
  return `"${value}"`;
}

function relation(opts: PostgresPresenceOptions): string {
  if (opts.table.length > 52) throw new Error('Presence table name is too long');
  return `${identifier(opts.schema)}.${identifier(opts.table)}`;
}

/** Call during migration or serialized bootstrap. The containing schema must already exist. */
export async function ensurePostgresPresenceTable(opts: PostgresPresenceOptions): Promise<void> {
  const table = relation(opts);
  await opts.client.query(`create table if not exists ${table} (
    tenant_id text not null,
    resource_id text not null,
    user_id text not null,
    participant jsonb not null,
    expires_at timestamptz not null,
    primary key (tenant_id, resource_id, user_id)
  )`);
  await opts.client.query(`create index if not exists ${identifier(`${opts.table}_expires_at`)}
    on ${table} (expires_at)`);
}

/** Shared across processes connected to the same PostgreSQL database. The database supplies the clock. */
export function createPostgresPresenceManager(opts: PostgresPresenceOptions): PresenceManager {
  const ttl = opts.ttlMs ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw new RangeError('ttlMs must be a positive safe integer');
  const table = relation(opts);
  const { client } = opts;
  const scoped = 'tenant_id = $1 and resource_id = $2';
  const list = async ({ tenantId, runId }: PresenceScope): Promise<RunPresenceParticipant[]> => {
    const result = await client.query(`select participant from ${table}
      where ${scoped} and expires_at > statement_timestamp()`, [tenantId, runId]);
    // The adapter is the sole writer and stores normalized participant JSON.
    const participants = result.rows.map((row) => row['participant'] as RunPresenceParticipant);
    return participants.sort((a, b) => a.peerType === b.peerType
      ? a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
      : a.peerType === 'human' ? -1 : 1);
  };
  return {
    async heartbeat(scope, beat) {
      const { userId, displayName, presence, peerType = 'human', color, cursor } = beat;
      const payload = JSON.stringify({ userId, displayName, presence, peerType, color, cursor });
      await client.query(`insert into ${table} as current_presence (tenant_id, resource_id, user_id, participant, expires_at)
        values ($1, $2, $3,
          $4::jsonb || jsonb_build_object('lastHeartbeatAt', floor(extract(epoch from statement_timestamp()) * 1000)),
          statement_timestamp() + $5::double precision * interval '1 millisecond')
        on conflict (tenant_id, resource_id, user_id) do update
          set participant = excluded.participant, expires_at = excluded.expires_at
          where current_presence.expires_at <= excluded.expires_at`,
      [scope.tenantId, scope.runId, userId, payload, ttl]);
      return list(scope);
    },
    async leave(scope, userId) {
      await client.query(`delete from ${table} where ${scoped} and user_id = $3`, [scope.tenantId, scope.runId, userId]);
      return list(scope);
    },
    list,
    async sweep() {
      const result = await client.query(`with expired as (
        delete from ${table} where expires_at <= statement_timestamp() returning tenant_id, resource_id
      ) select distinct tenant_id, resource_id from expired`);
      return result.rows.map((row) => ({ tenantId: String(row['tenant_id']), runId: String(row['resource_id']) }));
    },
  };
}
