# ADR 002: Heartbeat and Attention Policy

**Date:** 2024-01  
**Status:** Accepted  
**Deciders:** Architecture team  

## Context

Agents need to perform work without constant human prompts. A scheduler (heartbeat) must decide:

1. **When** to run agent actions (every hour, every day, on external event?)
2. **What** action to run (compress context, check email, review contract?)
3. **How often** to retry if action fails?
4. **What if** two workers claim the same action simultaneously?

This decision record defines the heartbeat model.

## Decision

**Heartbeat** is a scheduler that:
1. Periodically asks each agent: "What should you do next?"
2. Agent responds via **attention policy**: "Run compression at midnight, check email every 2 hours"
3. Heartbeat creates `TickSpec` objects and inserts into DB
4. Workers claim and execute ticks (see ADR 004 for claiming mechanism)

### Core types

```typescript
interface Tick {
  id: string;
  agentId: string;
  action: Action;         // What to do (e.g., COMPRESS_CONTEXT)
  scheduledFor: Date;     // When to run
  status: 'SCHEDULED' | 'CLAIMED' | 'COMPLETED' | 'FAILED';
  workerId?: string;      // Which worker claimed it
  claimedAt?: Date;
  completedAt?: Date;
  error?: string;
}

interface AttentionPolicy {
  (agent: Agent) => TickSpec[];
}

// Agent defines its own attention policy
const agent = await mesh.spawnAgent('analyst', {
  attentionPolicy: (agent) => {
    const now = new Date();
    const ticks = [];
    
    // Compress at midnight
    if (now.getHours() === 0) {
      ticks.push(new TickSpec({
        action: new Action({ name: 'COMPRESS_CONTEXT' }),
        scheduledFor: now,
      }));
    }
    
    // Check email every 2 hours
    if (now.getMinutes() === 0 && now.getHours() % 2 === 0) {
      ticks.push(new TickSpec({
        action: new Action({ name: 'CHECK_EMAIL' }),
        scheduledFor: now,
      }));
    }
    
    return ticks;
  },
});
```

### Execution flow

```
1. Heartbeat runs every 10 minutes (configurable)
   for each agent:
     2. Ask: agent.attentionPolicy(agent) → TickSpec[]
     3. For each TickSpec:
        4. Insert into heartbeat_ticks table if not already scheduled
     5. Emit event: TICKS_SCHEDULED (100 new ticks)

6. Workers run in parallel
   for each worker:
     7. Call stateStore.claimNextTicks(workerId, batchSize, now)
     8. Get atomic result: [Tick, Tick, ...]
     9. Execute each tick (call action.run(agent))
     10. Mark as COMPLETED or FAILED
```

## Why this design?

**Question:** Why not a cron-like scheduler?  
**Answer:** Cron is single-machine. Live-agents runs on many workers. Need distributed claiming.

**Question:** Why not event-driven (only schedule on external event)?  
**Answer:** Some actions are time-based (daily compression, hourly email check). Hybrid approach.

**Question:** Why heartbeat every 10 minutes?  
**Answer:** Trade-off between latency (how long until action runs) and overhead (scheduling API calls).

---

## Attention policy patterns

### 1. Time-based (most common)

```typescript
attentionPolicy: (agent) => {
  const hour = new Date().getHours();
  const minute = new Date().getMinutes();
  
  if (hour === 0 && minute === 0) {
    return [new TickSpec({ action: compressAction, scheduledFor: now })];
  }
  if (minute === 0) {
    return [new TickSpec({ action: checkEmailAction, scheduledFor: now })];
  }
  return [];
}
```

### 2. Contract-based (respond to queue)

```typescript
attentionPolicy: (agent) => {
  const ticks = [];
  
  // Check inbox for new contracts
  const newContracts = agent.contracts.filter(c => !c.processed);
  for (const contract of newContracts) {
    ticks.push(new TickSpec({
      action: new Action({ name: 'PROCESS_CONTRACT', input: { contractId: contract.id } }),
      scheduledFor: now,
    }));
  }
  return ticks;
}
```

### 3. Backpressure-aware

```typescript
attentionPolicy: (agent) => {
  // Only schedule if inbox is not overloaded
  const pendingContracts = agent.contracts.filter(c => c.status === 'PENDING');
  if (pendingContracts.length > 100) {
    return []; // Back off, don't schedule new work
  }
  
  return [new TickSpec({ action: checkEmailAction, scheduledFor: now })];
}
```

---

## Failure handling

If action fails:

```typescript
try {
  const result = await action.run(agent);
  await stateStore.saveTick({ ...tick, status: 'COMPLETED', result });
} catch (error) {
  await stateStore.saveTick({ ...tick, status: 'FAILED', error: error.message });
  
  // Retry logic
  if (tick.retryCount < 3) {
    await stateStore.saveTick({
      ...tick,
      retryCount: tick.retryCount + 1,
      scheduledFor: new Date(Date.now() + 60 * 1000), // Retry in 60 seconds
    });
  }
}
```

---

## Scaling considerations

### 1000 agents, 10 workers

- **Heartbeat runs:** Every 10 minutes
- **Ticks created:** 1000 agents × avg 2 ticks per agent = 2000 ticks per heartbeat run
- **Ticks claimed per worker:** 2000 / 10 workers = 200 ticks per worker per heartbeat
- **Load:** Manageable (database INSERT in batch, workers claim 200 per run)

### Optimization: Batch scheduling

Instead of one INSERT per TickSpec, batch:

```typescript
// Bad: 2000 INSERTs
for (const spec of tickSpecs) {
  await db.saveTick(spec);
}

// Good: 1 batch INSERT
await db.saveTicks(tickSpecs);
```

---

## Alternatives considered

### 1. Cron-style scheduling
Each agent defines cron expressions.

**Rejected:** Cron is for single-machine. Multi-worker claiming is harder.

### 2. Event-driven only
Only schedule on external event (email arrives, contract submitted).

**Rejected:** Some work is time-based (daily compression). Would need external event source.

### 3. Agent-initiated heartbeat
Agent calls `sendHeartbeat()` when ready.

**Rejected:** Agent doesn't know when it's ready. Heartbeat should determine.

## Consequences

**Positive:**
- Simple distributed model (all workers are equal)
- Flexible attention policy (time-based or event-based)
- Scales to 1000s of agents

**Negative:**
- Heartbeat every 10 minutes can feel slow (agent waits 10 min for work to be scheduled)
- Requires reliable DB for claiming (no single-node scheduler)
- Attention policy is agent responsibility (operator must set policy on all agents)

---

## References

- [Use Cases](./use-cases.md) — Example `57-live-agents-mesh-administration.ts`
- [ADR 004: State Store Proxy Pattern](./004-state-store-proxy-pattern.md) — How ticks are claimed atomically
- [@weaveintel/live-agents](../packages/live-agents/README.md) — `Heartbeat` API
