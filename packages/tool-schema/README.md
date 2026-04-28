# @weaveintel/tool-schema

Canonical tool schema → provider-specific format translation, plus
conversation-history re-shaping when the router swaps providers
mid-conversation.

This package is the runtime half of the *anyWeave Task-Aware Routing*
spec ([docs/ANYWEAVE_TASK_AWARE_ROUTING.md](../../docs/ANYWEAVE_TASK_AWARE_ROUTING.md)),
Phase 3 (M12). The DB half lives in GeneWeave's
`provider_tool_adapters` table — adding a new provider is a row + an
adapter registration, no fork required.

## Why

Every model provider expects tools in a slightly different shape:

| Provider  | Tool wrapper                                      | System prompt lives in           |
|-----------|---------------------------------------------------|----------------------------------|
| OpenAI    | `{ type: 'function', function: {...} }`           | `messages` (`role: 'system'`)    |
| Anthropic | `{ name, description, input_schema }`             | top-level `system` field         |
| Google    | `{ functionDeclarations: [...] }` (one wrapper)   | top-level `system_instruction`   |

Without a translator, every provider package re-implements the same
mapping. With this package, a single canonical `ToolDefinition[]` from
`@weaveintel/core` feeds every provider through one adapter contract.

## Quick start

```ts
import type { ToolDefinition } from '@weaveintel/core';
import {
  anthropicAdapter,
  openaiAdapter,
  googleAdapter,
  parseToolCall,
  translate,
  translateConversationHistory,
  validate,
} from '@weaveintel/tool-schema';

const tools: ToolDefinition[] = [{
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}];

// Forward translate
const openaiTools    = translate(tools, openaiAdapter);
const anthropicTools = translate(tools, anthropicAdapter);
const googleTools    = translate(tools, googleAdapter);

// Validate against an adapter's constraints (name regex, max tool count)
const issues = validate(tools, openaiAdapter); // []

// Parse a provider response back into normalised tool calls
const calls = parseToolCall(rawOpenAIResponse, openaiAdapter);
// → [{ id: 'call_…', name: 'get_weather', arguments: { city: 'Paris' } }]

// Reshape a conversation when the router switches provider mid-thread
const reshaped = translateConversationHistory(
  conversation,        // OpenAI-shaped messages with toolCalls + toolCallId
  openaiAdapter,       // from
  anthropicAdapter,    // to
);
```

## ProviderToolAdapter contract

```ts
export interface ProviderToolAdapter {
  readonly provider: string;
  readonly displayName: string;
  readonly systemPromptLocation: 'system_message' | 'top_level_field' | 'system_instruction';
  readonly nameValidationRegex: string;
  readonly maxToolCount: number;
  translate(tools: readonly ToolDefinition[]): unknown[];
  parseToolCall(rawResponse: unknown): readonly NormalisedToolCall[];
  reshapeMessage(message: Message): Message | null;
}
```

Adapters are pure data + pure functions — no provider SDKs are imported.

## Built-in adapters

```ts
import {
  defaultAdapterRegistry,
  openaiAdapter,
  anthropicAdapter,
  googleAdapter,
} from '@weaveintel/tool-schema';

defaultAdapterRegistry.list();
// → [openaiAdapter, anthropicAdapter, googleAdapter]
```

Apps may register additional adapters at runtime, including ones loaded
from the GeneWeave `provider_tool_adapters` DB table (see Phase 3 spec).

## Provider package integration

`@weaveintel/provider-openai` and `@weaveintel/provider-anthropic` now
delegate their internal `buildOpenAITools` / `buildAnthropicTools` helpers
to `translate(tools, openaiAdapter)` / `translate(tools, anthropicAdapter)`
so the canonical → provider mapping lives in one place. Output is
byte-equivalent to the prior inline implementations.

## Examples

- [`examples/71-tool-schema-translation.ts`](../../examples/71-tool-schema-translation.ts)
  — full walkthrough of all five capabilities (translate, parse, validate,
  history translation, registry).

## Spec & Phase status

| Phase | Spec section | Status |
|-------|--------------|--------|
| 1     | M11 — `provider_tool_adapters` DB table + 3 seed rows | ✅ shipped |
| 2     | M9 — task-aware router + decision traces              | ✅ shipped |
| **3** | **M12 — `@weaveintel/tool-schema` runtime translator + provider refactor** | ✅ **this package** |
| 4     | M15 + M16 — task-aware routing admin API + UI (CRUD over task types, capability matrix heatmap, provider-tool adapters, tenant overrides, decision-trace log, simulator) | ✅ shipped (see [`examples/72-routing-admin-phase4.ts`](../../examples/72-routing-admin-phase4.ts)) |
| 5     | M13 + M14 — capability-score feedback loop (eval / chat / cache / production signals → `routing_capability_signals`, `message_feedback`, `routing_surface_items`) + daily regression detector with auto-disable | ✅ shipped (see [`examples/73-routing-feedback-phase5.ts`](../../examples/73-routing-feedback-phase5.ts)) |
