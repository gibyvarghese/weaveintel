# @weaveintel/observability

**See what an agent actually did: traces every step, tracks token usage and cost, and logs runs so you can replay them later.**

## Why it exists

When an agent finishes, all you usually have is the final answer — not the trail of model calls, tool invocations, and retries that produced it. When something goes wrong or costs too much, that missing trail is exactly what you need. Think of it like the black-box recorder on a plane: it quietly captures every move while the flight happens, so that afterward you can play the whole thing back and understand precisely what led where. This package is that recorder for your runs.

## When to reach for it

Reach for it when you want spans and timelines for a run, running token/cost totals, or a recorded trace you can replay for debugging. It *observes* — it doesn't change behavior. If you want to *enforce* a spend budget, use `@weaveintel/cost-governor`; if you want to block unsafe output, use `@weaveintel/guardrails`.

## How to use it

```ts
import { weaveConsoleTracer, weaveUsageTracker } from '@weaveintel/observability';

const tracer = weaveConsoleTracer();
const span = tracer.startSpan('model.generate', { model: 'gpt-4o' });
span.end({ tokens: 150 });

const usage = weaveUsageTracker();
usage.record({ model: 'gpt-4o', promptTokens: 100, completionTokens: 50, cost: 0.003 });
```

## What's in the box

Main entry (`@weaveintel/observability`):

- Tracers: `weaveConsoleTracer` (logs spans to stdout), `weaveInMemoryTracer` (collect spans for assertions), `weaveUsageTracker` (aggregate tokens and cost).
- OpenTelemetry: `createOtelTracer`, `weaveOtlpSink`, plus `GEN_AI` semantic-convention attribute keys and span/event annotators.
- Budget & timeline: `weaveBudgetTracker` (alerts on spend), `weaveTraceGraph` / `formatTraceGraph`, `weaveRunTimeline`, `weaveJsonSink`.

Subpath export:

- `@weaveintel/observability/replay` — replay a recorded trace to step back through a run.

## License

MIT.
