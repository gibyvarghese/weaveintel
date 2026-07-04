# @weaveintel/provider-anthropic

**The adapter that lets weaveIntel talk to Anthropic's Claude models through the framework's common provider interface.**

## Why it exists

Every AI vendor speaks its own dialect: the shape of a request, the names of the fields, the way tool calls and images come back are all slightly different. If your app wired itself directly to one vendor's API, switching later would mean rewriting a lot of code. Think of this package as a power adapter for travelling abroad — your laptop (the rest of weaveIntel) plugs into the same socket everywhere, and the adapter quietly handles the local wiring. This one handles the Anthropic wall socket.

## When to reach for it

Reach for this when you want your agents and pipelines to run on Claude — for chat, tool use, vision, PDF reading, extended thinking, or citations. If you'd rather run on GPT models, use `@weaveintel/provider-openai`; for Gemini, `@weaveintel/provider-google`; and for models on your own machine, `@weaveintel/provider-ollama` or `@weaveintel/provider-llamacpp`. You can mix and match — the code that consumes them doesn't change.

## How to use it

```ts
import { weaveAnthropic } from '@weaveintel/provider-anthropic';

// One model instance, ready to use behind the framework's common interface.
const model = weaveAnthropic('claude-sonnet-4-5');

const reply = await model.generate({
  messages: [{ role: 'user', content: 'Explain photosynthesis in one sentence.' }],
});

console.log(reply.text);
```

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveAnthropic` | Quick way to get a ready-to-use Claude model instance by id. |
| `weaveAnthropicModel`, `weaveAnthropicConfig` | The underlying model class and its config, for finer control. |
| `manualThinking`, `adaptiveThinking`, `disableThinking` | Turn Claude's extended "thinking" on, auto, or off. |
| `extractThinkingBlocks`, `extractRawContentBlocks`, `generateWithThinking` | Read back the model's thinking and raw content blocks. |
| `weaveAnthropicCountTokens` | Count tokens for a request before you send it. |
| `weaveAnthropicCreateBatch`, `weaveAnthropicGetBatch`, `weaveAnthropicListBatches`, `weaveAnthropicCancelBatch`, `weaveAnthropicDeleteBatch`, `weaveAnthropicGetBatchResults` | Submit and manage large jobs through the Message Batches API. |
| `weaveAnthropicComputerTool`, `weaveAnthropicTextEditorTool`, `weaveAnthropicBashTool` | Ready-made computer-use tools (screen, editor, shell). |
| `weaveAnthropicScreenshotResult`, `weaveAnthropicTextResult`, `COMPUTER_USE_BETA` | Helpers for returning computer-use tool results. |

## License

MIT.
