# @weaveintel/agents

Agent runtime — ReAct-style tool-calling loop, hierarchical supervisor-worker orchestration, self-critique, rubric verification, and ensemble conflict resolution.

## Exports

```typescript
import {
  weaveAgent,          // single-agent AND supervisor-mode factory
  weaveSupervisor,     // thin alias for weaveAgent({ workers: [...] })
  weaveEnsemble,       // run N agents, resolve via vote / judge / arbiter
  createVoteResolver,  // majority-vote ConflictResolver
  createJudgeResolver, // rubric-scored ConflictResolver
  createArbiterResolver, // model-synthesised ConflictResolver
  createSelfCritic,    // W1 self-critique Critic
  createRubricCritic,  // W1 rubric-scored Critic
  weaveRubricVerifier, // W2 evaluator-optimizer Verifier
  buildSupervisorUtilityTools, // datetime + math_eval + unit_convert
  buildDatetimeTool,
  mathEvalTool,
  unitConvertTool,
} from '@weaveintel/agents';
```

---

## Quick start: single agent

```typescript
import { weaveAgent } from '@weaveintel/agents';
import { weaveContext, weaveRuntime } from '@weaveintel/core';

const agent = weaveAgent({
  model,                                // any @weaveintel/core Model
  tools: toolRegistry,                  // optional ToolRegistry
  systemPrompt: 'You are a helpful assistant.',
  maxSteps: 10,
  name: 'my-agent',
});

const ctx = weaveContext({ runtime: weaveRuntime() });
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What is 3 + 4?' }],
});
// result.status === 'completed' | 'failed' | 'budget_exceeded' | 'guardrail_denied' | 'needs_approval'
// result.output — final text
// result.steps  — full execution trace
// result.usage  — token + step counts
```

---

## Supervisor-worker

`weaveAgent` enters supervisor mode when `workers` is provided. The built-in
`think`, `plan`, and `delegate_to_worker` tools are auto-registered along with
the optional utility tools (`datetime`, `math_eval`, `unit_convert`).

```typescript
import { weaveAgent } from '@weaveintel/agents';

const supervisor = weaveAgent({
  model,
  name: 'coordinator',
  workers: [
    {
      name: 'researcher',
      description: 'Searches the web and summarises findings',
      model: fastModel,
      tools: webSearchRegistry,
    },
    {
      name: 'writer',
      description: 'Writes and formats documents',
      model: strongModel,
    },
  ],
  maxDelegations: 8,
  replanOnFailure: true,    // W3: inject REPLAN_REQUIRED on worker failure
  parallelDelegation: true, // W3: enable delegate_to_workers_parallel tool
});
```

`weaveSupervisor` is a named alias with identical behaviour:

```typescript
import { weaveSupervisor } from '@weaveintel/agents';
const sv = weaveSupervisor({ model, workers: [...] });
```

---

## W1 — Reflection (self-critique loop)

```typescript
const agent = weaveAgent({
  model,
  reflect: {
    maxRevisions: 2,
    criteria: 'Is the answer accurate, concise, and directly addresses the question?',
    minScore: 0.7,
    // critic: createRubricCritic({ adapter, criteria }) // custom critic
  },
});
```

### Using a rubric critic

```typescript
import { createRubricCritic } from '@weaveintel/agents';

const critic = createRubricCritic({
  adapter: myRubricJudge,
  criteria: [
    { id: 'accuracy', description: 'Factually correct', weight: 0.6 },
    { id: 'clarity', description: 'Clearly written', weight: 0.4 },
  ],
  minScore: 0.75,
});

const agent = weaveAgent({ model, reflect: { critic, maxRevisions: 1 } });
```

---

## W2 — Verify → regenerate

```typescript
import { weaveRubricVerifier } from '@weaveintel/agents';

const verifier = weaveRubricVerifier(myAdapter, {
  criteria: [{ id: 'relevance', description: 'Directly answers the question', weight: 1 }],
  minScore: 0.8,
});

const agent = weaveAgent({
  model,
  verify: { verifier, maxAttempts: 2 },
});
```

---

## W5 — Ensemble

`weaveEnsemble` implements the `Agent` interface and can be used anywhere an
`Agent` is expected (including as a worker inside a supervisor).

```typescript
import { weaveEnsemble, createVoteResolver, createArbiterResolver } from '@weaveintel/agents';

const ensemble = weaveEnsemble({
  agents: [agentA, agentB, agentC],
  resolver: createVoteResolver(),   // or createJudgeResolver / createArbiterResolver
  parallel: true,                   // run all agents concurrently
});

// Use directly
const result = await ensemble.run(ctx, input);
console.log(result.winner);     // which agent won
console.log(result.candidates); // all outputs before resolution

// Or as a supervisor worker
const supervisor = weaveAgent({
  model,
  workers: [{ name: 'ensemble', description: 'Multi-model consensus', model: ensemble.config.model! }],
});
```

### Conflict resolvers

| Resolver | Description |
|---|---|
| `createVoteResolver()` | Majority vote; first-encountered wins ties |
| `createJudgeResolver({ adapter, criteria })` | Rubric-scored; highest score wins |
| `createArbiterResolver({ model, instruction? })` | Model synthesises or picks the best |

---

## Approval gate (`requireApproval`)

When `requireApproval: true` is set, the agent requires a `policy.approveToolCall`
gate to be wired. Without one it immediately returns `status: 'needs_approval'`.

```typescript
const agent = weaveAgent({
  model,
  requireApproval: true,
  policy: {
    async shouldContinue() { return { continue: true }; },
    async approveToolCall(_ctx, schema) {
      // approve or deny each tool call
      return { approved: schema.name !== 'dangerous_tool' };
    },
  },
});
```

---

## Supervisor utility tools

Pure, deterministic, side-effect-free tools always available at the supervisor level:

| Tool | Description |
|---|---|
| `datetime` | Current date/time — formats: `iso`, `unix`, `unix_ms`, `date`, `human`, `time`, `weekday`, `rfc2822` |
| `math_eval` | Arithmetic — `+`, `-`, `*`, `/`, `**`, `%`, parentheses |
| `unit_convert` | Length, mass, volume, time, temperature conversions |

---

## Agent result statuses

| Status | Meaning |
|---|---|
| `completed` | Final response produced and passed all guardrails |
| `failed` | Max steps exceeded with no terminal response |
| `cancelled` | Context expired or policy halted the loop |
| `budget_exceeded` | `maxTokenBudget` hit |
| `guardrail_denied` | Output blocked by a runtime output guardrail |
| `needs_approval` | `requireApproval: true` but no `policy.approveToolCall` gate is wired |
