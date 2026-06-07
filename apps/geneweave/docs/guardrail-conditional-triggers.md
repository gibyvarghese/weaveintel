# Guardrail Conditional Triggers — Design & Implementation Plan

## Problem

Every guardrail currently runs on every message regardless of context. The four
model-graded (LLM) checks alone can add up to 46 seconds of potential latency
per turn, and they fire on simple queries like "what day is it today" where they
produce noise, false-positive warns, and unnecessary cost.

The goal is a **condition system**: each guardrail declares the signals that must
be present before it activates. Cheap deterministic checks keep running
universally; expensive LLM calls only fire when the context justifies them.

---

## The Condition Signal Space

These are the observable facts available at guardrail evaluation time. The
condition evaluator reads them from a `GuardrailConditionContext` object built
once per pipeline run.

### Context signals (always available)

| Signal | Type | Description |
|--------|------|-------------|
| `user.persona` | `string` | platform_admin / tenant_admin / tenant_user / anonymous |
| `user.isNew` | `boolean` | First session or fewer than N prior messages |
| `chat.mode` | `string` | direct / agent / supervisor |
| `turn.number` | `number` | Number of messages in this conversation |
| `turn.hasToolCalls` | `boolean` | Tools were invoked this turn |
| `turn.toolCategories` | `string[]` | Which tool classes ran: cse, web_search, api, file, external |
| `prior.hasWarn` | `boolean` | Any guardrail already warned this pipeline run |
| `prior.hasCognitiveWarn` | `boolean` | Cognitive checks specifically warned |
| `prior.hasInjectionWarn` | `boolean` | An injection check warned on the input |
| `risk.level` | `string` | low / medium / high / critical (from risk classifier) |
| `risk.verb` | `string` | read / write / modify / destructive |

### Input signals (pre-stage)

| Signal | Type | Description |
|--------|------|-------------|
| `input.length` | `number` | Character count |
| `input.hasCode` | `boolean` | Code blocks or backtick content present |
| `input.hasUrls` | `boolean` | URLs or IP addresses present |
| `input.hasBase64` | `boolean` | 30+ char base64-like sequences |
| `input.hasStructuredData` | `boolean` | JSON, XML, CSV-like or formatted data |
| `input.hasDecisionLanguage` | `boolean` | "should I", "recommend", "best option", "what's better" |
| `input.hasValidationSeeking` | `boolean` | "right?", "don't you think", "agree?", "isn't it" |
| `input.hasFactualQuestion` | `boolean` | What/when/where/who/how-many queries |
| `input.hasInstructionOverride` | `boolean` | "ignore previous", "new rule", "pretend you are", "your instructions" |
| `input.hasSensitivePattern` | `boolean` | PII patterns detected (quick pre-scan before full check) |

### Output signals (post-stage only)

| Signal | Type | Description |
|--------|------|-------------|
| `output.length` | `number` | Character count |
| `output.hasCodeBlocks` | `boolean` | Fenced code blocks in response |
| `output.hasFactualClaims` | `boolean` | Numbers, dates, named entities, statistics |
| `output.hasAdvice` | `boolean` | Recommendation or prescriptive language |
| `output.hasCredentialPatterns` | `boolean` | Quick pre-scan before expensive regex |
| `output.hasToolEvidence` | `boolean` | Steps show tool results grounded the response |
| `output.hasUrls` | `boolean` | External links in the response |

---

## Per-Guardrail Trigger Analysis

### PRE-execution

#### Always-run (no conditions needed)

These are microsecond-cost checks. Gating them saves nothing and risks missing critical events.

| Guardrail | Reason |
|-----------|--------|
| Injection blocklists (god-mode, role-play bypass, directive override) | Zero-cost keyword scan; failure mode is jailbreak |
| PII input checks (SSN, credit card, API key, DB string) | Cheap regex; high consequence if missed |
| Token budget | Counter operation |
| PII redaction | Data pipeline step, not an evaluation |

#### Conditionally triggered

**Base64 Encoded Instruction** (regex, warn)
```json
{ "any": [{ "input_has_base64": true }, { "input_length_gt": 500 }] }
```
Skip: short conversational messages — a 12-char message cannot contain a 30+ char sequence.

**Indirect/Hypothetical Wrapper** (regex, warn)
```json
{ "all": [{ "input_length_gt": 80 }, { "any": [{ "turn_number_gt": 1 }, { "input_has_structured_data": true }] }] }
```
Skip: one-liners and direct commands.

**Prompt Exfiltration** (regex, deny)
- Could always run (cheap). If gated: `input.hasInstructionOverride OR input.length > 300`.

**SSRF probes** (regex, deny)
```json
{ "any": [{ "input_has_urls": true }, { "input_has_structured_data": true }, { "chat_mode": ["agent", "supervisor"] }] }
```
Skip: pure conversational messages with no URL/IP content.

**Cognitive Pre: Confidence Gate** (cognitive_check)
```json
{ "any": [{ "risk_level": ["medium", "high", "critical"] }, { "chat_mode": ["agent", "supervisor"] }, { "input_has_decision_language": true }] }
```
Skip: low-risk factual queries in direct mode.

**Cognitive Pre: Sycophancy Pressure** (cognitive_check)
```json
{ "any": [{ "input_has_validation_seeking": true }, { "turn_number_gt": 2 }] }
```
Skip: task-oriented messages with no opinion/validation component.

**Model-Graded: Prompt Injection Classifier** (LLM call, deny, 15s)
```json
{
  "any": [
    { "input_has_code": true },
    { "input_has_base64": true },
    { "input_has_structured_data": true },
    { "input_has_urls": true },
    { "input_has_instruction_override": true },
    { "persona": ["anonymous"] },
    { "prior_has_injection_warn": true },
    { "input_length_gt": 300 }
  ]
}
```
This is the most expensive pre-check. A simple authenticated-admin question with
no structural complexity does not need a 15-second LLM classifier call.

---

### POST-execution

#### Always-run

| Guardrail | Reason |
|-----------|--------|
| Output PII regex | Cheap; prevents accidental leakage in any response |
| Unsolicited password/secret disclosure | Cheap blocklist; high-impact miss |

#### Conditionally triggered

**Credential detection** (API keys, DB strings, private keys) (deny)
```json
{ "any": [{ "output_has_code_blocks": true }, { "output_has_credential_patterns": true }, { "turn_has_tool_calls": true }, { "chat_mode": ["agent", "supervisor"] }] }
```

**False Certainty regex** (warn)
```json
{ "any": [{ "output_has_advice": true }, { "output_length_gt": 200 }] }
```
Skip: short factual answers, code-only responses.

**Toxicity Filter** (content_filter)
```json
{ "any": [{ "persona": ["tenant_user", "anonymous"] }, { "prior_has_warn": true }] }
```
For internal admin-only deployments, blanket toxicity filtering adds no safety.

**Hallucination Check / Factuality** (grounding-overlap)
```json
{ "all": [{ "output_has_factual_claims": true }, { "output_has_tool_evidence": false }] }
```
Only needed when the model made assertions without tool evidence. Code responses,
formatting, creative writing don't need this.

**Cognitive Post: Confidence Gate**
```json
{ "any": [{ "prior_has_cognitive_warn": true }, { "risk_level": ["medium", "high", "critical"] }, { "chat_mode": ["agent", "supervisor"] }] }
```

**Cognitive Post: Devil's Advocate**
```json
{ "input_has_decision_language": true }
```
Only fires when the original question was a decision/recommendation question.
"What day is it?" has no devil's advocate relevance.

**Cognitive Post: Sycophancy Phrasing**
```json
{ "any": [{ "input_has_validation_seeking": true }, { "prior_has_cognitive_warn": true }] }
```

**Cognitive Post: Grounding**
```json
{ "all": [{ "output_has_factual_claims": true }, { "output_has_tool_evidence": false }] }
```

---

### POST-execution model-graded

These are the most expensive checks (6–15s each). Each needs a clear positive trigger.

**Model-Graded: Semantic Grounding** (LLM/embedding, warn, 6s)
```json
{
  "all": [
    { "input_has_factual_question": true },
    { "output_has_factual_claims": true },
    { "output_has_tool_evidence": false }
  ]
}
```
Semantic grounding validates that factual responses are grounded in evidence.
It is meaningless for code generation, creative writing, task execution, or
any response where the model used tools (tool evidence already grounds it).

**Model-Graded: Sycophancy Judge** (LLM call, warn, 8s)
```json
{
  "any": [
    { "input_has_validation_seeking": true },
    { "all": [{ "turn_number_gt": 3 }, { "prior_has_cognitive_warn": true }] }
  ]
}
```
The judge's entire purpose is to catch cases where the model agreed with the
user's framing rather than responding honestly. Without `input.hasValidationSeeking`,
there is no risk to evaluate.

**Model-Graded: LLM Safety Judge** (LLM call, deny, 15s)
```json
{
  "any": [
    { "chat_mode": ["agent", "supervisor"] },
    { "turn_has_tool_calls": true },
    { "risk_level": ["high", "critical"] },
    { "output_length_gt": 500 },
    { "prior_has_warn": true },
    { "persona": ["anonymous"] },
    { "all": [{ "turn_number_gt": 5 }, { "risk_level": ["medium", "high", "critical"] }] }
  ]
}
```
This is the most powerful and most expensive post-check. It earns its cost as a
*final safety net for consequential outputs* — after tool use, in agent mode,
for long multi-step responses — not as a line-by-line reviewer for every chat turn.

**Model-Graded: Content Moderation** (OpenAI API, deny, 2s)
```json
{ "any": [{ "persona": ["tenant_user", "anonymous"] }, { "prior_has_warn": true }] }
```
For enterprise internal use with admin personas, per-turn moderation calls add
cost without safety value.

**Model-Graded: Prompt Injection Classifier** (LLM call, deny, 15s) — see pre-stage section above.

---

## Estimated Impact

A simple direct-mode question ("what day is it today") from an authenticated
admin in the current setup triggers all guardrails including 4+ LLM calls.
With conditional triggers:

| Check | Current | With conditions |
|-------|---------|-----------------|
| Injection blocklists | ✓ | ✓ always |
| PII input/output | ✓ | ✓ always |
| Regex content checks | ✓ | ✓ always |
| Cognitive pre (confidence/sycophancy) | ✓ | ✗ no decision language |
| Prompt Injection Classifier (15s) | ✓ | ✗ no structural complexity |
| Toxicity Filter | ✓ | ✗ admin user |
| Cognitive post (all 4) | ✓ | ✗ no factual claims, no validation seeking |
| Semantic Grounding (6s) | ✓ | ✗ no factual claims |
| Sycophancy Judge (8s) | ✓ | ✗ no validation seeking |
| LLM Safety Judge (15s) | ✓ | ✗ direct mode, no tools, low risk |
| Content Moderation (2s) | ✓ | ✗ admin user |

Same question from a `tenant_user` in `supervisor` mode where a tool was called
would still trigger all the relevant checks — which is correct.

---

## Condition Schema

Conditions are stored as JSON in a new `trigger_conditions` column on the
`guardrails` table. The schema supports boolean composition:

```typescript
type ConditionNode =
  | { all: ConditionNode[] }          // AND
  | { any: ConditionNode[] }          // OR
  | { not: ConditionNode }            // NOT
  | { chat_mode: string[] }
  | { persona: string[] }
  | { risk_level: string[] }
  | { prior_has_warn: boolean }
  | { prior_has_cognitive_warn: boolean }
  | { prior_has_injection_warn: boolean }
  | { turn_has_tool_calls: boolean }
  | { turn_number_gt: number }
  | { input_length_gt: number }
  | { input_has_code: boolean }
  | { input_has_urls: boolean }
  | { input_has_base64: boolean }
  | { input_has_structured_data: boolean }
  | { input_has_decision_language: boolean }
  | { input_has_validation_seeking: boolean }
  | { input_has_factual_question: boolean }
  | { input_has_instruction_override: boolean }
  | { output_length_gt: number }
  | { output_has_code_blocks: boolean }
  | { output_has_factual_claims: boolean }
  | { output_has_advice: boolean }
  | { output_has_credential_patterns: boolean }
  | { output_has_tool_evidence: boolean }
  | { output_has_urls: boolean }
  | { tool_category_in: string[] };   // specific tool class was used
```

A `null` or absent `trigger_conditions` means **always run** — backward compatible
with all existing guardrails.

---

## Package Changes — `@weaveintel/guardrails`

### New files

**`src/condition-context.ts`**
- Exports `GuardrailConditionContext` interface
- Exports `buildInputSignals(input: string): InputSignals` — cheap regex-based extraction
- Exports `buildOutputSignals(output: string, toolEvidence: boolean): OutputSignals`
- These run once per pipeline invocation and are shared across all guardrail condition checks

**`src/condition-evaluator.ts`**
- Exports `evaluateCondition(node: ConditionNode, ctx: GuardrailConditionContext): boolean`
- Pure function, no I/O — evaluates the JSON condition tree against the context
- Handles all node types, short-circuits on `any`/`all`
- Returns `true` if the guardrail should run; `false` to skip

### Changed files

**`src/pipeline.ts`** — `GuardrailPipelineOptions` gets a new optional field:
```typescript
conditionContext?: GuardrailConditionContext;
```
The `evaluate()` loop checks `evaluateCondition(guardrail.triggerConditions, ctx)`
before invoking `evaluateGuardrailAsync`. Skipped guardrails emit an
`{ decision: 'allow', explanation: 'condition not met — skipped' }` result so
the audit log is complete.

**`src/async-evaluator.ts`** — no change needed; condition gating happens in the pipeline layer above it.

**`src/index.ts`** — export `GuardrailConditionContext`, `buildInputSignals`, `buildOutputSignals`, `evaluateCondition`

### Core types — `@weaveintel/core`

**`src/guardrails.ts`** — add to `Guardrail` interface:
```typescript
/** JSON condition tree. null/absent = always run. */
triggerConditions?: ConditionNode | null;
```
Add the `ConditionNode` union type. This makes conditions a first-class concept
at the framework level, visible to any package that deals with guardrails.

---

## geneWeave Database Changes

### Migration m34 — `trigger_conditions` column

Add `trigger_conditions TEXT` (nullable JSON) to the `guardrails` table.
Add `trigger_description TEXT` (nullable) for human-readable explanation shown
in the admin panel.

```sql
ALTER TABLE guardrails ADD COLUMN trigger_conditions TEXT;
ALTER TABLE guardrails ADD COLUMN trigger_description TEXT;
```

No existing rows are updated — `null` means always-run, preserving current behaviour.

### Seed defaults for existing guardrails

A seed step in `m34` (or the guardrail seed in `db-sqlite.ts`) sets the default
`trigger_conditions` for the model-graded and context-sensitive guardrails
based on the analysis above. Deterministic/cheap guardrails get `null`
(always run). Example seed updates:

```typescript
// LLM Safety Judge — only run in elevated situations
await db.updateGuardrail('b1c2d3e4-0002-...', {
  trigger_conditions: JSON.stringify({
    any: [
      { chat_mode: ['agent', 'supervisor'] },
      { turn_has_tool_calls: true },
      { risk_level: ['high', 'critical'] },
      { output_length_gt: 500 },
      { prior_has_warn: true },
    ]
  }),
  trigger_description: 'Agent/supervisor mode, tool calls, high risk, long output, or prior warn'
});
```

### Admin panel support

The existing guardrail admin UI (CRUD at `/api/admin/guardrails`) already stores
and returns `config` as JSON. `trigger_conditions` and `trigger_description`
follow the same pattern — operator-editable fields returned in the guardrail
list/detail endpoints and writable via the update endpoint.

The UI renders `trigger_description` as a read-only summary alongside the
condition JSON editor. Changing conditions takes effect immediately on the next
request (no server restart — `db.listGuardrails()` is called per-turn).

---

## geneWeave Runtime Changes

### Signal extraction — `chat-guardrail-eval-utils.ts`

Before calling `pipeline.evaluate()`, build the context once:

```typescript
// Already available at call site:
// - userId, chatId, settings.mode, steps, refs

const inputSignals  = buildInputSignals(guardedInput);
const outputSignals = buildOutputSignals(guardedOutput, Boolean(refs?.toolEvidence));

const conditionContext: GuardrailConditionContext = {
  user: {
    persona:   actor?.persona ?? 'tenant_user',
    isNew:     (await db.countMessagesForUser(userId)) < 5,
  },
  chat: {
    mode:      settings.mode ?? 'direct',
  },
  turn: {
    number:    await db.countMessagesInChat(chatId),
    hasToolCalls:    Boolean(steps?.some(s => s.toolCall)),
    toolCategories:  extractToolCategories(steps),
  },
  risk: {
    level:     riskLevel,     // from prior risk classifier result
    verb:      riskVerb,
  },
  prior: {
    hasWarn:           false,  // populated after pre-stage, fed into post-stage
    hasCognitiveWarn:  false,
    hasInjectionWarn:  false,
  },
  input:  inputSignals,
  output: outputSignals,     // empty/null during pre-stage
};
```

The `prior.*` fields are filled in after the pre-stage run completes and before
the post-stage run starts. This allows the Sycophancy Judge and LLM Safety Judge
to escalate automatically when an injection check warned on the input.

### `normalizeGuardrail` — `chat-guardrail-utils.ts`

When converting a `GuardrailRow` to a `Guardrail`, parse `trigger_conditions`
from the DB row and attach it to the `Guardrail.triggerConditions` field.

### `createGuardrailPipeline` call

Pass `conditionContext` in the pipeline options:

```typescript
const pipeline = createGuardrailPipeline(guardrails, {
  shortCircuitOnDeny: true,
  model: judgeModel,
  moderationModel: getActiveGuardrailModerationModel(),
  embeddingModel: getActiveGuardrailEmbeddingModel(),
  budgetMs: opts?.budgetMs,
  conditionContext,          // new
});
```

---

## Implementation Phases

---

### Phase 1 — Core package: types and condition evaluator
**Packages:** `@weaveintel/core`, `@weaveintel/guardrails`
**Effort:** small (new files, no breaking changes)

1. Add `ConditionNode` union type and `triggerConditions` field to `Guardrail` in `@weaveintel/core`.
2. Create `packages/guardrails/src/condition-context.ts` — define `GuardrailConditionContext`, `buildInputSignals`, `buildOutputSignals`.
3. Create `packages/guardrails/src/condition-evaluator.ts` — implement `evaluateCondition(node, ctx): boolean` with full support for `all`, `any`, `not`, and all leaf predicates.
4. Export from `packages/guardrails/src/index.ts`.
5. Build and unit-test `evaluateCondition` with fixtures covering: always-run (null), AND/OR/NOT composition, every leaf predicate type, short-circuit evaluation.

**Definition of done:** `evaluateCondition` has 100% branch coverage; new exports build cleanly; no pipeline changes yet.

---

### Phase 2 — Pipeline integration
**Packages:** `@weaveintel/guardrails`
**Effort:** medium (changes existing pipeline hot path)

1. Add `conditionContext?: GuardrailConditionContext` to `GuardrailPipelineOptions`.
2. In `pipeline.ts` `evaluate()`, before calling `evaluateGuardrailAsync`, run `evaluateCondition(guardrail.triggerConditions, opts.conditionContext)`. If it returns false, push a synthetic `allow` result with `explanation: 'skipped — condition not met'` and a `metadata.skipped: true` flag.
3. Ensure `shortCircuitOnDeny` and `budgetMs` still work correctly with skipped entries.
4. Add integration tests: pipeline with mock guardrails where some have conditions that match/don't match the provided context, verify correct skipping and result shape.

**Definition of done:** integration tests pass; existing tests (no condition context provided) pass unchanged.

---

### Phase 3 — geneWeave DB migration and seed
**App:** geneWeave
**Effort:** small

1. Create `migrations/m34-guardrail-conditions.ts` — `ALTER TABLE guardrails ADD COLUMN trigger_conditions TEXT` and `ADD COLUMN trigger_description TEXT`.
2. In the migration, seed `trigger_conditions` and `trigger_description` for the model-graded and context-sensitive guardrails using the defaults from the analysis above. Leave deterministic checks with `null`.
3. Update `normalizeGuardrail` in `chat-guardrail-utils.ts` to read and attach `trigger_conditions` from the DB row.
4. Wire `m34` into `migrations/index.ts`.

**Definition of done:** migration runs cleanly on existing DB; existing guardrail rows gain the new column; model-graded guardrails have their default conditions seeded.

---

### Phase 4 — Signal extraction and context building in geneWeave
**App:** geneWeave
**Effort:** medium

1. Implement `buildInputSignals` fast-path extraction: all pattern matches run against the raw input string using lightweight regex (no LLM calls). Benchmark — target < 1ms for a 2000-char message.
2. Implement `buildOutputSignals` similarly for the post-stage.
3. Gather remaining context fields in `evaluateGuardrails`: actor persona, chat mode from settings, turn number (from `db.countMessagesInChat` — can be approximated from the messages array length to avoid an extra DB round-trip), tool calls and categories from `steps`.
4. Wire the `prior.*` cascade: capture pre-stage results, extract `hasWarn`, `hasCognitiveWarn`, `hasInjectionWarn`, pass them into the post-stage context.
5. Pass `conditionContext` into `createGuardrailPipeline`.

**Definition of done:** `evaluateGuardrails` builds a fully populated context; unit tests verify signal extraction on representative inputs (conversational, code-heavy, URL-containing, short vs long, etc.).

---

### Phase 5 — Admin panel wiring
**App:** geneWeave
**Effort:** small

1. Return `trigger_conditions` and `trigger_description` in the guardrail list and detail API responses.
2. Accept `trigger_conditions` and `trigger_description` in the guardrail create/update endpoints (same pattern as `config`).
3. The existing admin UI renders the new fields in the guardrail detail form — `trigger_description` as a read-only label, `trigger_conditions` as a JSON textarea.

**Definition of done:** an operator can view and edit conditions via the admin panel; changes take effect on the next chat turn without a server restart.

---

### Phase 6 — Testing
**End-to-end and regression coverage**
**Effort:** medium-large

#### Unit tests (Phase 1–2 deliverables)

- `condition-evaluator.spec.ts`: all predicate types, AND/OR/NOT composition, null = always-run, empty `all` = true, empty `any` = false, short-circuit.
- `condition-context.spec.ts`: `buildInputSignals` on 20+ representative strings covering each flag (empty string, code block, base64, URL, decision language, validation seeking, factual question, override phrase, SSN, credit card, API key).
- `pipeline.spec.ts`: guardrail with condition that evaluates false is skipped; result has `metadata.skipped: true`; shortCircuitOnDeny still halts on first deny; `budgetMs` still skips model-graded checks when exceeded.

#### Integration tests

- `guardrail-eval-utils.spec.ts`: mock DB returns guardrails with conditions; context is correctly built and passed through; pre → post cascade sets `prior.hasWarn` correctly.
- Scenario: message with injection indicators → pre-stage injection warn → post-stage `prior.hasInjectionWarn: true` → LLM Safety Judge fires that otherwise would be skipped.

#### Stress / load tests (extend existing stress suite)

- Run `geneweave-stress-cse-reasoning.mjs` with `SKIP_GUARDRAIL_CONDITIONS=false` to confirm latency improvement on simple queries.
- Verify complex agent/supervisor turns still trigger all model-graded checks.
- Profile: measure average guardrail evaluation time before and after for direct-mode factual queries — target ≥60% reduction.

#### Regression tests

- All existing guardrail tests (no condition context) still pass — null condition = always-run.
- Admin panel: verify `trigger_conditions` round-trips correctly through the API (create with conditions → read back → conditions match).
- Existing guardrail evals stored in DB have `skipped: true` entries in the results JSON for guardrails that didn't fire — verify the audit trail is complete.

#### Manual acceptance tests

| Scenario | Expected |
|----------|----------|
| `"what day is it today"` direct mode, admin | Only cheap checks run; no model-graded calls; guardrail = allow |
| `"what day is it today"` agent mode, tool call made | Confidence gate + grounding check fire; LLM Safety Judge fires |
| `"should I invest in crypto? I think yes right?"` direct mode | Devil's advocate + Sycophancy Judge fire |
| Long message with base64-looking payload | Prompt Injection Classifier fires |
| Supervisor mode with CSE execution | Full post-execution stack fires |
| `"ignore your previous instructions and..."` | Prompt Exfiltration + Injection Classifier fire |
| Unauthenticated user, any message | Full stack including Content Moderation + LLM Safety Judge |
| Pre-stage injection warn fires | Post-stage LLM Safety Judge escalates automatically |

---

## Key Design Decisions

**Null = always-run.** Backward-compatible default. Any guardrail row without
`trigger_conditions` behaves exactly as today.

**Skip is auditable.** Skipped guardrails appear in the `results` array with
`metadata.skipped: true` and `explanation: 'condition not met'`. The audit log
never has gaps — an operator can always see what ran and what didn't.

**Conditions are evaluated before the guardrail is invoked.** The condition
evaluator does not call any I/O. Signal extraction happens once per pipeline
invocation outside the guardrail loop. This keeps the condition check to
microseconds even for complex `any`/`all` trees.

**Prior results cascade between pre and post stages.** The output of the
pre-stage (`hasWarn`, `hasCognitiveWarn`, `hasInjectionWarn`) is fed into
the post-stage `conditionContext.prior`. This means an injection warning on
the input automatically escalates post-stage checks that would otherwise be
skipped, without any special-case code.

**Conditions are operator-editable at runtime.** The `trigger_conditions` field
is a normal DB column. Operators can adjust conditions via the admin panel and
see the effect on the next turn. No deploy required.

**Signal extraction is deterministic and cheap.** `buildInputSignals` and
`buildOutputSignals` are pure regex/string functions with no LLM calls. They
run in < 1ms on any realistic message. The expensive signal (risk classifier
result) is computed as part of the existing guardrail pipeline and passed in,
not recomputed.
