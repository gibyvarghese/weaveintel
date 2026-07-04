# @weaveintel/agents

**A tool-calling agent loop: give a model some tools and a goal, and it reasons, calls tools, checks its own work, and returns an answer.**

## Why it exists

A language model on its own can only talk — it can't look anything up or take an action. An agent is the model plus a set of tools and a loop: it reads the question, decides "I should search the web," calls that tool, reads the result, and keeps going until it has a real answer. Think of a capable assistant who doesn't just tell you what they think — they pick up the phone, open the spreadsheet, and come back with the finished result. This package is that loop, plus the extras that make it trustworthy: a supervisor that hands work to specialist workers, a self-critique pass, a rubric verifier, and an ensemble that runs several agents and reconciles their answers.

## When to reach for it

Reach for `@weaveintel/agents` when you want a single request answered start-to-finish in one process — a chat turn, a batch job, a scripted task. If instead you need agents that stay alive for days, wake on a schedule, and handle a mailbox of async messages, use `@weaveintel/live-agents`. If you want a fixed, auditable sequence of steps rather than a model deciding what to do next, use `@weaveintel/workflows`.

## How to use it

```ts
import { weaveAgent } from '@weaveintel/agents';
import { weaveContext, weaveRuntime } from '@weaveintel/core';

const agent = weaveAgent({
  model,                       // any @weaveintel/core Model
  tools: toolRegistry,         // optional ToolRegistry
  systemPrompt: 'You are a helpful assistant.',
  maxSteps: 10,
  name: 'my-agent',
});

const ctx = weaveContext({ runtime: weaveRuntime() });
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What is 3 + 4?' }],
});

console.log(result.status); // 'completed' | 'failed' | 'needs_approval' | ...
console.log(result.output); // final text
```

Pre-composed patterns live under the `/recipes` subpath:

```ts
import { createGovernedAssistant } from '@weaveintel/agents/recipes';
```

## What's in the box

| Export | What it does |
|---|---|
| `weaveAgent` | The core loop. Enters supervisor mode when you pass `workers`. |
| `weaveSupervisor` | Named alias for `weaveAgent({ workers: [...] })`. |
| `weaveEnsemble` | Runs N agents and reconciles them via a resolver. |
| `createVoteResolver` / `createJudgeResolver` / `createArbiterResolver` | Majority vote, rubric-scored, or model-synthesised conflict resolution. |
| `createSelfCritic` / `createRubricCritic` | Critics for the built-in reflection (self-critique) loop. |
| `weaveRubricVerifier` | Verify-then-regenerate gate on the final output. |
| `buildSupervisorUtilityTools`, `buildDatetimeTool`, `mathEvalTool`, `unitConvertTool` | Pure, deterministic helper tools (date/time, arithmetic, unit conversion). |
| `runEvalPipeline` | Multi-tier evaluation pipeline (schema → reflect → verify → ensemble). |
| `createMemoryToolSet` / `createGraphMemoryToolSet` | Portable memory and knowledge-graph tools an agent can call. |
| `InMemoryCheckpointStore`, `createSQLiteCheckpointStore`, `resumeFromCheckpoint` | Save a run mid-flight and resume it later. |
| `createHumanTaskInterruptHandler` | Pause for human approval (human-in-the-loop). |
| `buildHandoffTools`, `weaveA2AWorker`, `weaveA2ASupervisor` | Agent-to-agent handoff and delegation. |
| `createAgentPlanCache` | Reuse structured plan templates across similar runs. |
| `@weaveintel/agents/recipes` | Pre-wired assistants — governed, approval-driven, ACL-aware RAG, multi-tenant, eval-routed, and more. |

## License

MIT.
