# Compression Guide

Context compression is critical for agents running months or years. This guide covers strategies, implementation, and cost-benefit trade-offs.

## Problem

An agent interacting daily for 6 months generates:
- **500 interactions** (chat turns)
- **2 million tokens** of interaction history
- **$30–50 in API costs** just for context window in next inference

Without compression:
- Model context fills (4K, 8K, 128K tokens)
- Older interactions are dropped or pruned heuristically
- Agent loses important lessons learned in month 1

**Compression solves:** Summarize months of interaction into a compact "summary + recent interactions" format.

## Compression strategies

### 1. Daily summary (recommended for long-running agents)

Summarize each day's work into a fixed-token summary. Retain 90–180 daily summaries.

**Setup:**
```typescript
const agent = await mesh.spawnAgent('analyst', {
  compressionStrategy: {
    window: 'daily',
    summaryPrompt: `Summarize today's work:
- Key findings discovered
- Hypotheses refined or rejected
- Open questions for tomorrow
- Resources consumed (API calls, tokens)`,
    tokenBudget: 2000,
    retention: 90, // Keep 90 daily summaries = 3 months
  },
});
```

**How it works:**

1. **Day 1:** Agent interacts, accumulates 50 interactions (~5K tokens)
2. **Midnight:** Heartbeat triggers summary
   - Input: All 50 interactions + summary prompt
   - Output: 1 daily summary (~1.5K tokens)
   - Store: `DailySummary { date, tokens, summary }`
3. **Day 2–90:** Repeat. Accumulate 90 daily summaries.
4. **Day 91:** Oldest summary is archived (not forgotten, but not in active context)
5. **Model inference:** Context = `[90 daily summaries] + [recent 1-7 interactions]`
   - Total: ~180K tokens (90 × 2K summaries) + recent interactions
   - Cost: ~$2–3 per inference vs. $30+ without compression

**Benefits:**
- ✅ Predictable token budget
- ✅ Long retention (3+ months)
- ✅ Automatic (heartbeat-driven)
- ✅ Retains context from month 1

**Trade-offs:**
- ❌ Summaries can lose nuance
- ❌ Requires LLM call at midnight (small cost)
- ❌ Daily cutoff is arbitrary (what if work spans midnight?)

---

### 2. Rolling window (simple, token-bounded)

Keep only the last N interactions, discard older ones.

**Setup:**
```typescript
const agent = await mesh.spawnAgent('analyst', {
  compressionStrategy: {
    window: 'rolling',
    maxTokens: 8000,  // Keep last 8K tokens of interactions
  },
});
```

**How it works:**
1. Interactions accumulate in memory
2. When total tokens exceed `maxTokens`, drop oldest interactions
3. Model inference sees: `[last 8K tokens of interactions]`

**Benefits:**
- ✅ Simple (no summarization LLM call)
- ✅ Zero latency (just trimming)
- ✅ Predictable cost

**Trade-offs:**
- ❌ Loses context after a few days (8K tokens = ~40 interactions)
- ❌ Agent forgets lessons from month 1
- ❌ No audit trail of discarded interactions

**Use when:** Development/testing, short-lived agents (days), high throughput (100s of agents).

---

### 3. Hierarchical summary (advanced)

Compress summaries into higher-level summaries.

**Setup:**
```typescript
const agent = await mesh.spawnAgent('analyst', {
  compressionStrategy: {
    window: 'hierarchical',
    levels: [
      { window: 'daily', retention: 30, tokenBudget: 2000 },
      { window: 'weekly', retention: 52, tokenBudget: 3000 },
      { window: 'monthly', retention: 12, tokenBudget: 5000 },
    ],
  },
});
```

**How it works:**
1. Daily: Summarize day into 2K tokens
2. Every Sunday: Summarize 7 daily summaries into 3K weekly summary
3. Every month: Summarize 4 weekly summaries into 5K monthly summary
4. Model sees: `[12 monthly] + [52 weekly] + [30 daily] + [recent interactions]`
   - Total: ~150K tokens, 1+ year of history

**Benefits:**
- ✅ Longest retention (1–2 years)
- ✅ Still compressed (predictable token budget)
- ✅ Coarse + fine granularity (recent details, historical patterns)

**Trade-offs:**
- ❌ Complex to implement
- ❌ Multiple LLM calls (3 per day)
- ❌ Abstractions lose nuance at each level

**Use when:** Very long-lived agents (1+ years), high-value interactions (research, compliance).

---

## Implementation

### Heartbeat integration

Compression is triggered by the heartbeat scheduler:

```typescript
// In app, define compress action
const compressAction = new Action({
  name: 'COMPRESS_CONTEXT',
  run: async (agent) => {
    if (!agent.compressionStrategy) return;
    
    const interactions = await stateStore.loadMessages(agent.id);
    
    // Daily summary
    if (agent.compressionStrategy.window === 'daily') {
      const today = interactions.filter(m =>
        new Date(m.createdAt).toDateString() === new Date().toDateString()
      );
      
      const summary = await model.generate({
        prompt: `${agent.compressionStrategy.summaryPrompt}\n\nInteractions:\n${today.map(m => m.text).join('\n')}`,
      });
      
      await stateStore.saveDailySummary({
        agentId: agent.id,
        date: new Date(),
        summary: summary.text,
        tokens: summary.tokenCount,
      });
      
      // Delete old interactions (keep last 7)
      const keep = 7;
      await stateStore.deleteMessages(agent.id, { olderThan: new Date(Date.now() - keep * 24 * 60 * 60 * 1000) });
    }
  },
});

// Wire into heartbeat
const heartbeat = createHeartbeat({
  stateStore,
  attention: (agent) => {
    // Every day at midnight
    const hour = new Date().getHours();
    if (hour === 0) {
      return [new TickSpec({ action: compressAction })];
    }
    return [];
  },
});
```

### Token budget

Define a soft limit on context size:

```typescript
interface CompressionStrategy {
  window: 'daily' | 'rolling' | 'hierarchical';
  tokenBudget: number;  // Target size per daily summary
  retention: number;    // How many summaries to keep
}

// During inference
function buildContext(agent: Agent, model: Model) {
  let context = '';
  let tokens = 0;
  
  // 1. Add summaries (if available)
  for (const summary of agent.summaries.slice(-agent.compressionStrategy.retention)) {
    context += `\n[${summary.date.toISOString()}]\n${summary.summary}`;
    tokens += summary.tokens;
  }
  
  // 2. Add recent interactions (fit in budget)
  const budget = model.contextWindow - tokens - 2000; // Reserve 2K for output
  for (const interaction of agent.recentInteractions) {
    const interactionTokens = estimate(interaction.text);
    if (tokens + interactionTokens > budget) break;
    context += `\n${interaction.text}`;
    tokens += interactionTokens;
  }
  
  return { context, tokens };
}
```

---

## Cost-benefit analysis

| Strategy | Retention | Context Size | LLM Calls | Cost per Month | Best For |
|----------|-----------|--------------|-----------|---|---|
| Rolling | 1 day | 8K tokens | 0 | $5 | High throughput, short-lived |
| Daily | 90 days | 180K tokens | 1/day | $25 | Typical long-lived agents |
| Weekly | 1 year | 200K tokens | 1/week | $10 | Very long-lived, low cost |
| Hierarchical | 2 years | 150K tokens | 3/day | $30 | High-value interactions |

**Calculation example (daily strategy, 100 agents):**

- Cost without compression: 100 agents × 30 inferences/month × $0.01/1K tokens × 200K tokens = $600/month
- Cost with compression: 100 agents × 30 inferences/month × $0.01/1K tokens × 8K tokens + 100 × 30 summaries × $0.001 = $24 + $3 = $27/month
- **Savings:** $573/month (95% reduction)

---

## Monitoring compression

Track compression effectiveness:

```typescript
interface CompressionMetrics {
  date: Date;
  agentId: string;
  interactions: number;           // Raw interactions stored today
  tokensRaw: number;              // Tokens in raw interactions
  tokensCompressed: number;       // Tokens in daily summary
  compressionRatio: number;       // tokensRaw / tokensCompressed
  summaryQuality: number;         // 1-5 rating (human eval or LLM judge)
}

// Query at end of month
const metrics = await stateStore.query(`
  SELECT
    DATE(created_at) as date,
    COUNT(*) as interactions,
    SUM(token_count) as tokens_raw,
    SUM(
      CASE WHEN type = 'SUMMARY' THEN token_count ELSE 0 END
    ) as tokens_compressed
  FROM messages
  WHERE agent_id = ?
  GROUP BY DATE(created_at)
  ORDER BY date
`);

// Compression ratio should be 5–10x for daily strategy
// If < 3x, consider increasing tokenBudget
// If > 20x, summaries may be losing important details
```

---

## Troubleshooting

### Agent seems to forget past lessons

**Symptom:** After compression, agent repeats mistakes from 2 months ago.

**Cause:** Summary quality is poor (LLM cut corners).

**Fix:**
```typescript
{
  compressionStrategy: {
    window: 'daily',
    summaryPrompt: `[IMPORTANT] Create a detailed summary including:
1. Key findings that invalidated previous hypotheses
2. Common mistakes made today
3. Techniques that worked well
4. Open questions

Format as bullet points. Be specific.`,
    tokenBudget: 3000,  // Increase to allow detail
  },
}
```

### Compression runs are slow (midnight spike)

**Symptom:** All agents summarize at midnight. Inference API is overloaded. Summaries take 2 hours.

**Cause:** Synchronized heartbeat (all agents on same schedule).

**Fix:**
```typescript
// Shard agents across hours
const shardHour = hash(agent.id) % 24;

heartbeat.attention = (agent) => {
  const hour = new Date().getHours();
  if (hour === shardHour) {
    return [new TickSpec({ action: compressAction })];
  }
  return [];
};
```

### Missing summaries (summaries not generated)

**Symptom:** Agent reaching month 3, but no daily summaries exist. Context is raw interactions.

**Cause:** Heartbeat never ran. Worker crashed.

**Fix:**
```typescript
// Add monitoring
async function checkMissingSummaries(agentId) {
  const today = new Date().toDateString();
  const summary = await stateStore.getDailySummary(agentId, today);
  if (!summary) {
    console.error(`Missing daily summary for ${agentId} on ${today}`);
    // Manually trigger or alert operator
  }
}

// Run daily
setInterval(() => {
  for (const agentId of await stateStore.listActiveAgents()) {
    checkMissingSummaries(agentId);
  }
}, 6 * 60 * 60 * 1000); // Every 6 hours
```

---

## Related

- [Use Cases](./use-cases.md) — Example `55-live-agents-compression.ts`
- [StateStore Guide](./statestore-guide.md) — Where summaries are persisted
- [@weaveintel/live-agents](../packages/live-agents/README.md) — Framework API
