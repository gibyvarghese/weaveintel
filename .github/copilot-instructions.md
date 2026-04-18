# Copilot Instructions

## Architecture Priorities
- Prefer reusable package-level capabilities over app-local implementations when a feature belongs to the shared weaveIntel platform.
- Keep GeneWeave database-driven for prompts, skills, agents, policies, and related configurable capabilities.
- Route prompt parsing, rendering, and version normalization through `@weaveintel/prompts` instead of duplicating prompt logic inside apps.
- Treat prompt records as prompt assets only when they are genuinely model-authored instructions or reusable prompt compositions.
- Move behavior bundles, operational policies, and tool activation logic into skills, tools, contracts, or runtime policies when they are not prompt assets.

## Prompt Boundary
- Use prompts for templateable model instructions, reusable system/user message structures, few-shot exemplars, routing/judging/optimizer prompt assets, and model-facing text variants that benefit from versioning and experimentation.
- Use skills for reusable behavior packs that combine instructions, tool activation, and execution guidance.
- Use tools or workers for capabilities that must perform actions or fetch data instead of only shaping model text.
- Use runtime policies for orchestration rules, hard execution constraints, guardrails, and non-optional workflow behavior.
- Preserve strong descriptions and structured metadata on any prompt, skill, tool, or worker that is callable by an LLM.

## GeneWeave Expectations
- Wire GeneWeave to shared packages rather than keeping parallel app-only versions of the same logic.
- When prompt metadata changes, update GeneWeave database schema, admin CRUD, and runtime resolution together so the app remains internally consistent.
- Keep admin surfaces usable: prefer explicit labels, structured JSON fields only where needed, and defaults that make creation safe.
- Favor modular changes that help reduce pressure on large files such as `chat.ts`, `ui.ts`, `server.ts`, and `server-admin.ts`.

## Cross-Cutting Requirements
- Reuse shared observability and evaluation hooks for new AI capabilities instead of creating app-only telemetry paths.
- Update examples and supporting docs when adding or changing platform capabilities so end-to-end usage stays discoverable.
- Add concise comments only where the control flow or data mapping is non-obvious.
- Keep prompts grounded in runtime reality: if a prompt requires tools, data freshness, or deterministic checks, route that requirement through skills/tools/runtime policies instead of relying on instruction text alone.

## Grounding Reality Guardrails
- Treat prompt text as guidance, not guaranteed execution. Any requirement that must always happen (tool call, policy check, verification pass, formatting guarantee) belongs in code-level orchestration and shared runtime hooks.
- Keep execution strategies DB-driven and traceable: strategy selection should come from prompt metadata (`executionDefaults.strategy`) plus admin-managed strategy records, not hardcoded app-only conditionals.
- Ensure runtime metadata captures which strategy, contracts, and evaluations were used so observability and audits can explain model behavior after the fact.
- Prefer app-wide reusable helpers in `@weaveintel/prompts` for prompt execution and strategy overlays; GeneWeave should consume these helpers, not duplicate them.

## LLM-Callable Metadata
- Enforce detailed model-facing descriptions for prompts, skills, tools, and agents through shared validation helpers in `@weaveintel/core`.
- Prefer shared prompt runtime helpers in `@weaveintel/prompts` for DB-backed rendering with lifecycle hooks and evaluations.
- Keep admin UX labels explicit when fields are used for model discovery and routing.

## Phase 2 Prompt Capabilities (`@weaveintel/prompts`)

### Fragment Inclusions (`{{>key}}` syntax)
- Templates may embed reusable text blocks via `{{>fragmentKey}}` markers (note the `>` prefix distinguishing them from `{{variable}}` slots).
- Use `resolveFragments(template, registry)` to expand all fragment markers before interpolation; unresolvable keys are left in place for lint to catch.
- Build registries with `InMemoryFragmentRegistry` in-memory or load from the GeneWeave `prompt_fragments` DB table via `fragmentFromRecord(row)`.
- Use `extractFragmentKeys(template)` to discover all `{{>key}}` references in a template without a registry.
- Circular references are detected (max depth 5) and left unexpanded rather than throwing.
- GeneWeave DB: `prompt_fragments` table; admin CRUD at `/api/admin/prompt-fragments`.

### Framework Registry (Named Section Structures)
- Frameworks define ordered, named sections (e.g. role → task → context → expectations) assembled by `renderFramework(framework, sectionValues)`.
- Use `defaultFrameworkRegistry` which ships four built-ins: `rtce`, `full`, `critique`, `judge`.
- Build custom frameworks in-memory with `InMemoryFrameworkRegistry` or load from `prompt_frameworks` DB via `frameworkFromRecord(row)`.
- Only sections whose key is in `SYSTEM_SECTIONS` (currently `'role'`) map to the system message; all others map to the user turn.
- GeneWeave DB: `prompt_frameworks` table; admin CRUD at `/api/admin/prompt-frameworks`.

### Lint / Static Analysis
- Call `lintPromptTemplate(template, variables, values, context?)` after fragment expansion to get typed `PromptLintResult[]`.
- Nine built-in rules: `missing_required_variable`, `missing_optional_variable`, `undefined_variable`, `empty_template`, `excessive_size`, `unresolved_fragment`, `circular_fragment`, `missing_description`, `no_variables_declared`.
- Use `hasLintErrors(results)`, `topLintSeverity(results)`, `formatLintResults(results, promptName)` as diagnostic helpers.
- Attach `lintResults` to observability spans when non-empty to surface quality signals in production.

### Unified Entry Point: `renderWithOptions()`
- `renderWithOptions(template, variables, values, options?)` is the Phase 2 unified path: fragment expansion → optional lint → interpolation.
- Returns a `RenderResult` with `.text`, `.lintResults`, and `.expandedTemplate`.
- Prefer this over calling `resolveFragments` + `createTemplate().render()` separately.

### Provider-Aware Render Adapters
- `openAIAdapter()` → `.adaptText(userText, systemText?)` returns `{role, content}[]` compatible with OpenAI Chat Completions.
- `anthropicAdapter()` → `.adaptForAnthropic(userText, systemText?)` returns `{ system, messages }`.
- `textAdapter()` → `.toText(userText, systemText?)` returns a single concatenated string.
- `systemAsUserAdapter()` → wraps system content as `<<SYSTEM>>\n...\n<</SYSTEM>>` for models without a system role.
- `resolveAdapter(provider)` selects the right adapter from a `KnownProvider` string (`'openai' | 'anthropic' | 'text' | 'system-as-user'`).

### chat.ts Fragment Integration
- GeneWeave `chat.ts` loads enabled DB fragments before rendering a DB-backed system prompt and calls `resolveFragments()` to expand `{{>key}}` markers.
- Fragment expansion failure is non-fatal — the raw template is used as fallback.

## Phase 4 Prompt Capabilities (`@weaveintel/prompts`)

### Strategy Runtime (DB + Shared Package)
- Use `executePromptRecord(record, variables, options?)` as the package-level execution entry point when strategy overlays are needed.
- `executePromptRecord()` performs shared render + strategy resolution + evaluation hook execution in one path.
- Strategy resolution order: explicit `options.strategyKey` → prompt `executionDefaults.strategy` → fallback strategy.
- Load DB rows into runtime strategy definitions with `strategyFromRecord(row)` and register them in `InMemoryPromptStrategyRegistry`.
- Start with `defaultPromptStrategyRegistry`, then layer DB-defined strategies for app/tenant-specific behavior.
- GeneWeave DB: `prompt_strategies` table; admin CRUD at `/api/admin/prompt-strategies`.

