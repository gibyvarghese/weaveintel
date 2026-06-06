# Guardrails Enterprise Hardening — Implementation Notes

## Step 0 findings (deviations from the prompt)

| Area | Prompt said | Reality in code | How I handled it |
|---|---|---|---|
| `ModerationModel` location | `packages/core/src/models.ts` | `packages/core/src/moderation.ts` (separate file, already exported) | Imported from `./moderation.js` in core |
| `evaluateGuardrail` sync | Correct | Confirmed sync: `evaluateGuardrail(g, input, stage, ctx?): GuardrailResult` | Preserved unchanged |
| `pipeline.ts` eval loop | Uses async evaluator | Currently calls `evaluateGuardrail` synchronously inside async `evaluate()` | Updated W1 to `await evaluateGuardrailAsync(...)` |
| `model-graded` return | Placeholder allow | Returns `{ decision: 'allow', explanation: 'Model-graded guardrails require async evaluation' }` | Preserved for unregistered judges; registered ones now run |
| `@weaveintel/human-tasks` | `createApprovalTask` | Has `PolicyEvaluator`/`createPolicy` (different API) | W4 uses a callback adapter pattern — consumers provide the task handler |
| `ModerationCategory.score` | Correct | Confirmed: `{ category, flagged, score, appliedInputTypes }` | Used as-is |
| `GuardrailEvaluationContext` | No `AsyncGuardrailContext` | Context only has sync fields | Added `AsyncGuardrailContext` to core extending the base |
| `GuardrailType` | `'model-graded'` listed | Confirmed present in the union | W1 dispatches on `guardrail.type === 'model-graded'` |
| `RiskClassifier.classify` | Described as sync | Is `async` returning `Promise<{ level, explanation }>` | Called with `await` in the slot (already correct) |

## Architecture decisions

### W1 — async-evaluator.ts is the single async dispatch point
`evaluateGuardrailAsync` handles `model-graded` via the `AsyncEvaluatorRegistry`;
all other types delegate immediately to the existing sync `evaluateGuardrail`.
The pipeline's `evaluate()` now awaits it — zero behaviour change for sync types.

### W2 — Built-in evaluators auto-register via side-effect import
`evaluators/register.ts` calls `defaultRegistry.register(...)` for each built-in.
`index.ts` imports it as a side-effect so any consumer of `@weaveintel/guardrails`
gets the built-ins automatically. New seed rows for model-graded checks are
**disabled by default** (`enabled: 0`).

### W4 — Escalation uses a callback, not a hard dep on `@weaveintel/human-tasks`
`evaluateEscalation(results, policies, ctx, handler?)` accepts an optional
`EscalationTaskHandler` callback. geneWeave's chat pipeline can pass a
`createApprovalTask` wrapper; other consumers can use their own task system.
The interface (`EscalationPolicy`, `EscalationResult`) lives in core.

### W5 — Streaming guard checks a rolling buffer; terminal `checkOutput` still runs
`createStreamingGuardrail` only runs cheap sync guardrails (blocklist/regex) on
each chunk. It does NOT replace the terminal `checkOutput` call the agent loop
already makes — both run. Halt is signalled via a returned `{ halt: true }` so
callers can abort the stream via their own `AbortController`.

### W6 — Resolver uses global → tenant → persona layering
Later layers override earlier layers by guardrail ID. The `GuardrailResolver`
interface is in core; `InMemoryGuardrailResolver` is in the guardrails package.
The pipeline's `evaluate()` is unchanged; consumers call the resolver before
constructing the pipeline.

### W9 — Telemetry is non-intrusive
`durationMs` is recorded in every `GuardrailResult.metadata` automatically.
An optional `budgetMs` in `PipelineOptions` skips remaining `model-graded`
guardrails once the budget is exceeded (cheap sync guardrails always run).

### W10 — Normalizer is applied as a pre-pass in the evaluators
`normalizeInput(text, opts)` is called at the top of `evaluateBlocklist`,
`evaluateRegex`, and `evaluateCustom` in `guardrail.ts`. Existing tests are
unaffected because ASCII input is unchanged by NFKC + zero-width stripping.

## How a consumer opts into each capability

| Workstream | Opt-in mechanism |
|---|---|
| W1 async foundation | Automatic — pipeline now awaits `evaluateGuardrailAsync` internally |
| W2 model-graded | Pass `model`/`moderationModel` in `PipelineOptions`; enable seed rows |
| W3 semantic grounding | Pass `embeddingModel` in `PipelineOptions`; add/enable a `semantic-grounding` guardrail row |
| W4 escalation | Call `evaluateEscalation(results, policies, ctx, handler)` after `pipeline.evaluate()` |
| W5 streaming | Wrap the agent stream with `createStreamingGuardrail(opts)` |
| W6 per-tenant resolver | Call `resolver.resolve(ctx)` to get the guardrail list; pass to `createGuardrailPipeline` |
| W7 revision audit | Wrap guardrail create/update with `trackGuardrailChange(store, ctx, change)` |
| W8 eval harness | Run `npm run guardrails:eval` in `packages/guardrails` |
| W9 telemetry | Check `result.metadata.durationMs`; set `budgetMs` in `PipelineOptions` |
| W10 normalisation | On by default; disable per-guardrail via `config.normalize: false` |

## geneWeave wiring guide

geneWeave's `guardrails-slot.ts` (`geneweaveGuardrailsSlot`) uses
`createGuardrailPipeline` and will automatically benefit from W1/W9/W10.
To enable W2/W3, pass the model references from geneWeave's runtime model
resolver into `PipelineOptions`. For W4 escalation, call `evaluateEscalation`
after the pipeline result in `chat-guardrail-eval-utils.ts`, wiring it to
`@weaveintel/human-tasks`'s `createApprovalTask` as the handler.
