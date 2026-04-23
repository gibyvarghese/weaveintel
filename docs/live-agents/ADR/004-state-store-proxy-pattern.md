# ADR 004: StateStore Proxy Pattern

**Date:** 2024-01  
**Status:** Accepted  
**Deciders:** Architecture team  

## Context

Live-agents requires both ephemeral state (leases, in-progress work) and durable state (contracts, messages, audit logs).

Two models:

1. **Single store:** Use one store for everything (ephemeral + durable).
   - Problem: Redis is fast but ephemeral. Postgres is durable but slower. Can't satisfy both.

2. **Dual store:** In-memory store for ephemeral, Postgres for durable. Keep them in sync.
   - Problem: Consistency. If in-memory crashes, leases are lost.

We chose **dual store with proxy pattern**.

## Decision

**StateStore Proxy** wraps two stores:

```typescript
interface StateStore {
  // Ephemeral store (in-memory or Redis)
  ephemeralStore: StateStore;
  // Durable store (Postgres, DynamoDB)
  durableStore: StateStore;
}

// In-memory for development
const stateStore = createProxyStateStore({
  ephemeralStore: weaveInMemoryStateStore(),
  durableStore: weaveInMemoryStateStore(), // For demo
});

// Production: Redis for ephemeral, Postgres for durable
const stateStore = createProxyStateStore({
  ephemeralStore: weaveRedisStateStore({ url: 'redis://...' }),
  durableStore: new PostgresStateStore(connectionString),
});
```

### Write routing

```
saveMesh(mesh)
  → durableStore.saveMesh(mesh)  [always durable]
  → skip ephemeralStore         [durable only]

claimNextTicks(workerId, count, now)
  → ephemeralStore.claimNextTicks(...)  [ephemeral: fast leasing]
  → No durable write              [ticket state not persisted]

saveExternalEvent(event)
  → durableStore.saveExternalEvent(event)  [durable]
  → ephemeralStore.deleteExternalEvent(event.id)  [cleanup if cached]
```

### Read routing

```
loadMesh(id)
  → Check ephemeralStore (fast cache)
     If found and not stale: return
     Else: load from durableStore, store in ephemeral, return

loadContracts(agentId)
  → Load from durableStore (source of truth)
  → Cache in ephemeralStore for next read
```

### Operations table

| Operation | Ephemeral | Durable | Rationale |
|-----------|-----------|---------|-----------|
| `saveMesh()` | Write-through cache | Write | Mesh is rarely changed |
| `loadMesh()` | Check cache first | Read if miss | Reduce DB load |
| `saveContract()` | Skip | Write | Contracts immutable after save |
| `loadContracts()` | Cache on read | Read | Reduce DB load |
| `claimNextTicks()` | Write (lease) | Skip | Lease is ephemeral |
| `completeTick()` | Delete (lease done) | Write (history) | Log history, clear lease |
| `saveExternalEvent()` | Skip | Write + idempotency | External events must not duplicate |
| `saveAccountBinding()` | Skip | Write | Bindings are immutable |

---

## Why this design?

**Question:** Why not cache everything?  
**Answer:** Some data is authoritative (contracts, bindings). Caching adds complexity. Better to cache selectively.

**Question:** Why Redis instead of just memory?  
**Answer:** Ephemeral store must be distributed. Two workers can't both hold in-memory leases; they won't see each other's claims.

**Question:** What if Redis crashes?  
**Answer:** Leases are lost. Worker reboots, heartbeat reschedules ticks. No data loss (ticks were never executed).

---

## Implementation

### Proxy factory

```typescript
export function createProxyStateStore(opts: {
  ephemeralStore: StateStore;
  durableStore: StateStore;
}): StateStore {
  return {
    async saveMesh(mesh: Mesh): Promise<void> {
      // Durable write
      await opts.durableStore.saveMesh(mesh);
      
      // Invalidate cache
      this.ephemeralCache.delete(`mesh:${mesh.id}`);
    },

    async loadMesh(id: string): Promise<Mesh | null> {
      // Check cache
      const cached = this.ephemeralCache.get(`mesh:${id}`);
      if (cached && !this.isCacheStale(cached)) {
        return cached;
      }
      
      // Load from durable
      const mesh = await opts.durableStore.loadMesh(id);
      if (mesh) {
        this.ephemeralCache.set(`mesh:${id}`, mesh);
      }
      return mesh;
    },

    async claimNextTicks(
      workerId: string,
      count: number,
      now: Date
    ): Promise<HeartbeatTick[]> {
      // Ephemeral only (leasing is fast, atomic)
      return await opts.ephemeralStore.claimNextTicks(workerId, count, now);
    },

    async completeTick(tick: HeartbeatTick): Promise<void> {
      // Delete ephemeral lease
      await opts.ephemeralStore.deleteTick(tick.id);
      
      // Write to durable history
      await opts.durableStore.saveTick({
        ...tick,
        status: 'COMPLETED',
        completedAt: new Date(),
      });
    },
  };
}
```

### Cache invalidation

```typescript
interface CacheEntry<T> {
  value: T;
  storedAt: Date;
}

function isCacheStale(entry: CacheEntry<any>): boolean {
  const age = Date.now() - entry.storedAt.getTime();
  return age > 5 * 60 * 1000; // 5 minute TTL
}
```

---

## Multi-worker scenario

### Tick claiming (atomicity requirement)

```
Worker A and B both call claimNextTicks(count=50, now)

Worker A: SELECT ... FOR UPDATE → claim 50 rows → COMMIT
Worker B: SELECT ... FOR UPDATE → waiting (locked)
Worker A: Release lock

Worker B: SELECT ... FOR UPDATE → claim different 50 rows → COMMIT

Result: No two workers claimed the same tick (atomic)
```

**Implementation:** Ephemeral store must support `FOR UPDATE` (SQL databases). Redis uses Lua scripting.

### Contract creation (no duplicate risk)

```
Both workers receive same email.
Both create contract with (contractId, message).

Worker A: INSERT contract_123, message_body
  → Success

Worker B: INSERT contract_123, message_body
  → Fails (duplicate PK)
  → Retry with new ID (message UUID is different)
  → Success (contract_124)

Result: Two contracts from same email (acceptable, contracts are idempotent inputs)
```

---

## Scaling

### 1000 agents, 10 workers, 100 ticks per agent per day

**Ephemeral store (Redis):**
- `claimNextTicks()` calls: 10 workers × 24 hours = 240 calls/day
- Lease entries: ~10 concurrent (batchSize * numWorkers / throughput)
- Memory: ~1KB per lease × 10 = 10KB (negligible)

**Durable store (Postgres):**
- `saveTick()` (history): 1000 agents × 100 ticks × 1 day = 100K rows/day
- `saveContract()`: 1000 agents × avg 50 contracts/day = 50K rows/day
- Total: ~200K rows/day (easily handled by Postgres)

---

## Monitoring

### Cache hit rate

```typescript
interface CacheMetrics {
  reads: number;
  hits: number;
  misses: number;
  hitRate: number; // hits / reads
}

// Track in proxy
async loadMesh(id: string): Promise<Mesh | null> {
  metrics.reads++;
  const cached = this.ephemeralCache.get(`mesh:${id}`);
  if (cached && !this.isCacheStale(cached)) {
    metrics.hits++;
    return cached;
  }
  metrics.misses++;
  // ...
}

// Query at end of day: "Cache hit rate should be 70-90%"
// If < 50%, increase cache TTL or cache size
```

### Lease efficiency

```typescript
// Tick claiming efficiency
interface LeaseMetrics {
  claimsTotal: number;
  claimsSuccessful: number;
  claimsFailed: number; // (e.g., all ticks already claimed)
  avgTicksPerClaim: number;
}

// If avgTicksPerClaim is low (< 10), increase batchSize
// If claimsFailed is high (> 10%), reduce heartbeat interval
```

---

## Alternatives considered

### 1. Single Postgres store
Use Postgres for everything (ephemeral + durable).

**Rejected:** Slow for high-throughput leasing (many workers contending for locks).

### 2. Single Redis store
Use Redis for everything.

**Rejected:** Data loss on restart. Contracts must be durable.

### 3. Write-through cache (always consistent)
Every write goes to both ephemeral and durable.

**Rejected:** Slower. Defeats purpose of ephemeral fast path.

## Consequences

**Positive:**
- Fast lease claiming (Redis/in-memory)
- Durable audit trail (Postgres)
- Selective caching reduces DB load

**Negative:**
- Dual-write complexity (must sync both stores)
- Cache invalidation bugs (hard to debug)
- Requires monitoring (cache hit rate, lease efficiency)

---

## Related

- [StateStore Guide](../statestore-guide.md) — Implementation patterns
- [ADR 002: Heartbeat](./002-heartbeat-attention-policy.md) — Tick claiming
- [@weaveintel/live-agents](../../packages/live-agents/README.md) — StateStore API
