# @weaveintel/provider-google

**The adapter that lets weaveIntel talk to Google's Gemini models through the framework's common provider interface.**

## Why it exists

Every AI vendor speaks its own dialect: the request shape, the field names, the way tool calls and images come back are all a little different. Wire your app straight to one vendor and switching later means a rewrite. Think of this package as a power adapter for travelling abroad — your laptop (the rest of weaveIntel) plugs into the same socket everywhere, and the adapter handles the local wiring. This one handles the Google Gemini socket.

## When to reach for it

Reach for this when you want your agents and pipelines to run on Gemini — for chat, tool use, vision, and streaming. Prefer Claude instead? Use `@weaveintel/provider-anthropic`. Prefer GPT models? Use `@weaveintel/provider-openai`. Want to run locally on your own machine? Use `@weaveintel/provider-ollama` or `@weaveintel/provider-llamacpp`. The code that consumes the model stays the same whichever you pick.

## How to use it

```ts
import { weaveGoogle } from '@weaveintel/provider-google';

// One Gemini instance, ready behind the framework's common interface.
const model = weaveGoogle('gemini-2.5-flash');

const reply = await model.generate({
  messages: [{ role: 'user', content: 'Explain photosynthesis in one sentence.' }],
});

console.log(reply.text);
```

Importing the package auto-registers the `google` and `gemini` providers with the model router, so routing can find them by name.

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveGoogle` | Quick way to get a ready-to-use Gemini model instance by id. |
| `weaveGoogleModel` | The underlying model class, for finer control. |
| `weaveGoogleConfig` | Configuration used when constructing a model (API key, base URL, etc.). |
| `GoogleProviderOptions` | The TypeScript type describing those options. |

## License

MIT.
