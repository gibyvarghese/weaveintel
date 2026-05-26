# With-LLM examples

These examples connect to a real LLM and make live API calls.

## Prerequisites

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

All examples default to Anthropic Claude. Set your key and run:

```bash
npx tsx examples/with-llm/anthropic-agent.ts
```

## What makes these different from `packages/` and `use-cases/`

- **`packages/`** — in-memory, no LLM, verifies the package API in isolation
- **`use-cases/`** — in-memory, no LLM, verifies multi-package composition
- **`with-llm/`**  — real API call, real tokens, real cost

These examples are intentionally kept simple so you can see the full
WeaveIntel stack (routing → resilience → provider → memory → artifacts)
working end-to-end with a live response.

## Cost awareness

Each run makes 1–3 LLM API calls. With `claude-haiku-4-5-20251001` this is a
fraction of a cent per run. The examples print the token counts so you can
see exactly what was charged.

## Files

| File | Description |
|------|-------------|
| `anthropic-agent.ts` | Single-turn Claude agent with model routing, resilience, memory, and artifact storage |
