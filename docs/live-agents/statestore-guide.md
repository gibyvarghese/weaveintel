# StateStore Guide

The `StateStore` interface is the persistence boundary. Applications implement `StateStore` to wire in their own databases. Two implementations ship with the framework; applications provide others.

## Shipped implementations

### InMemoryStateStore

```typescript
const stateStore = weaveInMemoryStateStore();
```

- **Persistence:** None (all data in-memory)
- **Use:** Tests, examples, single-process demos
- **Concurrency:** Single-process only (no locking)

**Limitations:**
- Data lost on restart
- No multi-worker coordination
- Not suitable for production

### RedisStateStore

```typescript
const stateStore = weaveRedisStateStore({
  url: 'redis://localhost:6379',
});
```

- **Persistence:** Redis (ephemeral key-value store)
- **Use:** Distributed coordination, ephemeral state
- **Concurrency:** Multi-worker (atomic operations via Lua)

**Important:** Redis is ephemeral. Use it for:
- Lease locks (heartbeat workers claiming ticks)
- Temporary state (in-progress message processing)

**Do not use it for:**
- Authoritative mesh/agent/message data
- Audit trails or compliance records

**Pattern:** Combine with app-provided durable store.

```typescript
// Worker (ephemeral Redis state)
const leaseStore = weaveRedisStateStore({ url: 'redis://...' });

// App (durable Postgres state)
const durableStore = new PostgresStateStore(connectionString);

// Heartbeat uses Redis for leasing
const heartbeat = createHeartbeat({
  stateStore: leaseStore,
  // App loads durable data separately
});
```

## Implementing StateStore

Applications bring their own implementations. Common: Postgres, DynamoDB, or hybrid ephemeral + durable.

### Example: PostgresStateStore

See `apps/live-agents-demo/src/postgres-state-store.ts` for a complete example.

**Pattern:**

```typescript
export async function createPostgresStateStore(
  connectionString: string
): Promise<StateStore> {
  const pool = new Pool({ connectionString });

  return {
    // Meshes
    async saveMesh(mesh: Mesh): Promise<void> {
      await pool.query(
        `INSERT INTO meshes (id, payload_json, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET payload_json = $2, updated_at = NOW()`,
        [mesh.id, JSON.stringify(mesh)]
      );
    },

    async loadMesh(id: string): Promise<Mesh | null> {
      const result = await pool.query(
        `SELECT payload_json FROM meshes WHERE id = $1`,
        [id]
      );
      return result.rows[0]
        ? JSON.parse(result.rows[0].payload_json)
        : null;
    },

    // ... similar for agents, contracts, messages, etc.

    async claimNextTicks(
      workerId: string,
      count: number,
      now: Date
    ): Promise<HeartbeatTick[]> {
      // CRITICAL: Atomic operation. No two workers claim the same tick.
      const result = await pool.query(
        `UPDATE heartbeat_ticks
         SET worker_id = $1, leased_until = $4
         WHERE id IN (
           SELECT id FROM heartbeat_ticks
           WHERE status = 'SCHEDULED' AND scheduled_for <= $3
           LIMIT $2
           FOR UPDATE
         )
         RETURNING payload_json`,
        [workerId, count, now, new Date(Date.now() + 5 * 60 * 1000)]
      );
      return result.rows.map(r => JSON.parse(r.payload_json));
    },

    async transaction<T>(
      fn: (tx: StateStore) => Promise<T>
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(
          // Create transactional store wrapper
          new TransactionalStateStore(client)
        );
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
```

### Key operations

#### claimNextTicks (critical for multi-worker)

```typescript
async claimNextTicks(
  workerId: string,
  count: number,
  now: Date
): Promise<HeartbeatTick[]>
```

**Must be atomic.** Two workers calling `claimNextTicks` in parallel must not both receive the same tick.

**Implementation pattern (SQL):**

```sql
UPDATE heartbeat_ticks
SET worker_id = ?, leased_until = ?
WHERE id IN (
  SELECT id FROM heartbeat_ticks
  WHERE status = 'SCHEDULED' AND scheduled_for <= ?
  LIMIT ?
  FOR UPDATE  -- Lock selected rows
)
RETURNING *;
```

The `FOR UPDATE` ensures atomicity across workers.

#### saveExternalEvent (idempotency)

```typescript
async saveExternalEvent(
  event: ExternalEvent
): Promise<void>
```

**Must be idempotent on `(accountId, sourceType, sourceRef)`.**

If the same Gmail message arrives via two MCP subscriptions, both must insert successfully, but no duplicate messages are created.

**Implementation pattern (SQL):**

```sql
INSERT INTO external_events (id, account_id, source_type, source_ref, payload_json, created_at)
VALUES (?, ?, ?, ?, ?, NOW())
ON CONFLICT (account_id, source_type, source_ref)
DO UPDATE SET updated_at = NOW()
```

#### transaction (read-committed minimum)

```typescript
async transaction<T>(
  fn: (tx: StateStore) => Promise<T>
): Promise<T>
```

**Must provide at least read-committed isolation.** Dirty reads are not allowed. Phantom reads are acceptable.

**Use for:** Multi-step operations (save message + update agent state atomically).

### Schema example (Postgres)

```sql
-- Meshes
CREATE TABLE meshes (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agents
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL REFERENCES meshes(id),
  payload_json TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  to_id TEXT NOT NULL,
  to_type TEXT NOT NULL, -- 'AGENT' or 'MESH'
  payload_json TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX messages_to ON messages(to_type, to_id);

-- Heartbeat ticks
CREATE TABLE heartbeat_ticks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  worker_id TEXT,
  leased_until TIMESTAMPTZ,
  payload_json TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX heartbeat_ticks_scheduled ON heartbeat_ticks(status, scheduled_for);

-- External events (idempotency constraint)
CREATE TABLE external_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, source_type, source_ref)
);
```

## DynamoDB example (sketch)

```typescript
export async function createDynamoStateStore(
  client: DynamoDBClient
): Promise<StateStore> {
  return {
    async claimNextTicks(workerId, count, now) {
      // DynamoDB: Use TransactWriteItems for atomicity
      // Fetch SCHEDULED ticks, update with worker_id in transaction
      // Must handle ConditionalCheckFailedException if already claimed
    },

    async saveExternalEvent(event) {
      // DynamoDB: Use Put with ConditionExpression for idempotency
      // Condition: attribute_not_exists(id) OR (sourceRef match)
    },

    // ... other operations ...
  };
}
```

## Testing StateStore implementations

Use the conformance test suite:

```typescript
import { testStateStoreConformance } from '@weaveintel/live-agents';

describe('MyStateStore', () => {
  testStateStoreConformance(() => createMyStateStore());
});
```

**Conformance tests verify:**
- `claimNextTicks` atomicity (multi-worker test)
- `saveExternalEvent` idempotency
- `transaction` isolation
- All CRUD operations
- Lifecycle management

## Performance considerations

### Indexes

Add indexes to frequently-queried columns:

```sql
-- Heartbeat scheduler queries ticks by status + time
CREATE INDEX heartbeat_ticks_next ON heartbeat_ticks(status, scheduled_for);

-- Message queries by recipient
CREATE INDEX messages_recipient ON messages(to_type, to_id);

-- Grants by agent
CREATE INDEX grants_agent ON capability_grants(agent_id, revoked_at);
```

### Partitioning

For large deployments (billions of messages), partition by:

- **Messages table:** Partition by month or tenant
- **Heartbeat ticks:** Partition by agent or date

### Connection pooling

Always use connection pooling:

```typescript
const pool = new Pool({
  max: 20,                     // Connection pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### Caching

Consider caching warm data:

```typescript
// Cache active contracts (read-heavy, write-rare)
const contractCache = new LRU({ max: 10000 });

async function loadContract(id) {
  let contract = contractCache.get(id);
  if (!contract) {
    contract = await pool.query(...);
    contractCache.set(id, contract);
  }
  return contract;
}
```

## Migration path

1. **Start with in-memory:** Develop locally with `weaveInMemoryStateStore()`
2. **Add Redis:** Multi-worker coordination during dev
3. **Implement app store:** Bring your own (Postgres, DynamoDB, etc.)
4. **Migrate data:** Export from in-memory/Redis, import into app store
5. **Dual-write:** Write to both old and new store, read from new, verify consistency
6. **Cutover:** Switch to new store, monitor

## Related

- `@weaveintel/live-agents` — Framework primitives
- `apps/live-agents-demo` — Reference Postgres implementation
- `@weaveintel/contracts` — Evidence ledger for compliance
- `@weaveintel/replay` — Replay framework (StateStore-agnostic)
