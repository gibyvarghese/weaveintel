import { Pool, type PoolClient } from 'pg';
import {
  weaveInMemoryStateStore,
  type Account,
  type AccountBinding,
  type AgentContract,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
  type Message,
  type StateStore,
} from '@weaveintel/live-agents';
import { MIGRATIONS_SQL } from './migrations.js';

export interface PostgresStateStore extends StateStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
}

interface Row {
  id: string;
  payload_json: string;
}

async function upsertPayload(client: PoolClient, table: string, id: string, payload: unknown): Promise<void> {
  await client.query(
    `
    INSERT INTO ${table} (id, payload_json, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (id)
    DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = NOW()
    `,
    [id, JSON.stringify(payload)],
  );
}

async function loadRows<T>(client: PoolClient, table: string): Promise<T[]> {
  const result = await client.query<Row>(`SELECT id, payload_json FROM ${table} ORDER BY updated_at ASC`);
  return result.rows.map((row) => JSON.parse(row.payload_json) as T);
}

export async function createPostgresStateStore(databaseUrl: string): Promise<PostgresStateStore> {
  const pool = new Pool({ connectionString: databaseUrl });
  const inMemory = weaveInMemoryStateStore();

  const initialize = async (): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query(MIGRATIONS_SQL);
      const [meshes, agents, contracts, messages, ticks, accounts, bindings] = await Promise.all([
        loadRows<Mesh>(client, 'la_meshes'),
        loadRows<LiveAgent>(client, 'la_agents'),
        loadRows<AgentContract>(client, 'la_contracts'),
        loadRows<Message>(client, 'la_messages'),
        loadRows<HeartbeatTick>(client, 'la_heartbeat_ticks'),
        loadRows<Account>(client, 'la_accounts'),
        loadRows<AccountBinding>(client, 'la_account_bindings'),
      ]);

      for (const mesh of meshes) await inMemory.saveMesh(mesh);
      for (const agent of agents) await inMemory.saveAgent(agent);
      for (const contract of contracts) await inMemory.saveContract(contract);
      for (const message of messages) await inMemory.saveMessage(message);
      for (const tick of ticks) await inMemory.saveHeartbeatTick(tick);
      for (const account of accounts) await inMemory.saveAccount(account);
      for (const binding of bindings) await inMemory.saveAccountBinding(binding);
    } finally {
      client.release();
    }
  };

  const close = async (): Promise<void> => {
    await pool.end();
  };

  const store = new Proxy(inMemory as StateStore, {
    get(target, prop, receiver) {
      if (prop === 'initialize') return initialize;
      if (prop === 'close') return close;

      if (prop === 'saveMesh') {
        return async (mesh: Mesh): Promise<void> => {
          await target.saveMesh(mesh);
          const client = await pool.connect();
          try {
            await upsertPayload(client, 'la_meshes', mesh.id, mesh);
          } finally {
            client.release();
          }
        };
      }
      if (prop === 'saveAgent') {
        return async (agent: LiveAgent): Promise<void> => {
          await target.saveAgent(agent);
          const client = await pool.connect();
          try {
            await upsertPayload(client, 'la_agents', agent.id, agent);
          } finally {
            client.release();
          }
        };
      }
      if (prop === 'saveContract') {
        return async (contract: AgentContract): Promise<void> => {
          await target.saveContract(contract);
          const client = await pool.connect();
          try {
            await upsertPayload(client, 'la_contracts', contract.id, contract);
          } finally {
            client.release();
          }
        };
      }
      if (prop === 'saveMessage') {
        return async (message: Message): Promise<void> => {
          await target.saveMessage(message);
          const client = await pool.connect();
          try {
            await upsertPayload(client, 'la_messages', message.id, message);
          } finally {
            client.release();
          }
        };
      }
      if (prop === 'saveHeartbeatTick') {
        return async (tick: HeartbeatTick): Promise<void> => {
          await target.saveHeartbeatTick(tick);
          const client = await pool.connect();
          try {
            await upsertPayload(client, 'la_heartbeat_ticks', tick.id, tick);
          } finally {
            client.release();
          }
        };
      }
      if (prop === 'saveAccount') {
        return async (account: Account): Promise<void> => {
          await target.saveAccount(account);
          const client = await pool.connect();
          try {
            await upsertPayload(client, 'la_accounts', account.id, account);
          } finally {
            client.release();
          }
        };
      }
      if (prop === 'saveAccountBinding') {
        return async (binding: AccountBinding): Promise<void> => {
          await target.saveAccountBinding(binding);
          const client = await pool.connect();
          try {
            await upsertPayload(client, 'la_account_bindings', binding.id, binding);
          } finally {
            client.release();
          }
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as PostgresStateStore;

  await store.initialize();
  return store;
}
