# @weaveintel/guardrails

**A safety pipeline that inspects what goes into and comes out of your LLM, and decides whether to allow, warn, or block it.**

## Why it exists

An LLM will happily answer a question it should refuse, leak a phone number that should have been hidden, or follow a malicious instruction that a user smuggled into pasted text. You could scatter `if`-checks through your app, but then every safety rule lives in a different place and nobody can say which ones actually ran. Think of this package as the security checkpoint at an airport: every request walks through the same line of scanners, each scanner reports what it found, and one clear decision comes out the other end — pass, flag, or stop.

## When to reach for it

Reach for it when you send user input to a model, or model output to a user, and you need consistent, auditable safety checks in between — content moderation, prompt-injection defense, PII redaction, or risk-based escalation. If all you need is per-tenant LLM spend limits with no content rules, use `@weaveintel/cost-governor` instead; if you need retries and circuit breakers around flaky calls, that's `@weaveintel/resilience`.

## How to use it

```ts
import { createGuardrailPipeline, hasDeny, getDenyReason } from '@weaveintel/guardrails';

const pipeline = createGuardrailPipeline();

const result = await pipeline.evaluate({
  text: userMessage,
  stage: 'input',
});

if (hasDeny(result)) {
  throw new Error(`Blocked: ${getDenyReason(result)}`);
}
// safe to continue to the model
```

## What's in the box

Main entry (`@weaveintel/guardrails`):

- `createGuardrailPipeline` / `DefaultGuardrailPipeline` — run the full evaluation chain; `hasDeny`, `hasWarning`, `getDenyReason` read the outcome.
- `createRiskClassifier`, `createConfidenceGate`, `createActionGate` — classify risk and gate low-confidence or high-risk actions.
- `createCostGuard` — stop a run that has spent past its budget.
- Model-graded evaluator factories: `createModerationEvaluator`, `createInjectionEvaluator`, `createLlmJudgeEvaluator`, `createSemanticGroundingEvaluator`, `createSycophancyEvaluator`.
- `createGuardrailResolver` (per-tenant config), `createStreamingGuardrail` (screen output as it streams).

Subpath exports:

- `@weaveintel/guardrails/redaction` — detect and redact PII before it reaches a model or a log.
- `@weaveintel/guardrails/compliance` — consent, deletion, legal-hold, data residency, and retention primitives.
- `@weaveintel/guardrails/spotlighting` — `spotlight`, `fenceUntrusted`, `spotlightPreamble`: fence untrusted text so the model can't mistake it for instructions (OWASP LLM01).

## License

MIT.
