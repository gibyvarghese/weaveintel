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
| `geminiAdapter`, `vertexAdapter` | Registry adapters: Google described as data, keys fetched per call. See below. |
| `googleChatBody`, `googleErrorOverride`, `signServiceAccountAssertion` | The building blocks those adapters use, exported for tests and for other adapters. |

## Google as a provider described by data

For applications where an administrator adds a provider and pastes its key on a screen, this package also exports two adapters for [`@weaveintel/provider-registry`](../provider-registry/README.md). They hold no key: the registry fetches it when a call is made and keeps it out of every error and event.

```ts
import { createProviderRegistry } from '@weaveintel/provider-registry';
import { geminiAdapter, vertexAdapter } from '@weaveintel/provider-google';

const registry = createProviderRegistry({ adapters: [geminiAdapter(), vertexAdapter()], secrets, privateEndpoints: [] });

// Gemini API: one key.
const gemini = { id: 'prov-7', kind: 'gemini', displayName: 'Google Gemini', secrets: { apiKey: 'vault:prov-7:apiKey' } };
const chat = registry.chatModel(gemini, { id: 'gemini-2.5-flash', kind: 'chat' });

// Vertex AI: a service-account file, a project and a location. All three are data.
const vertex = {
  id: 'prov-8', kind: 'vertex', displayName: 'Vertex AI', region: 'us-central1',
  settings: { project: 'my-project' }, secrets: { serviceAccount: 'vault:prov-8:serviceAccount' },
};
const embedder = registry.embeddingModel(vertex, {
  id: 'text-embedding-005', kind: 'embedding',
  embedding: { nativeDimensions: 768, dimensions: [256, 768], reduce: 'provider', normalized: false, batchLimit: 250, modes: ['document', 'query'] },
}, { dimensions: 256 });
```

| Adapter | Chat | Embeddings | Key |
| --- | --- | --- | --- |
| `geminiAdapter()` (kind `gemini`) | `generateContent`, `streamGenerateContent` | `batchEmbedContents`, with the size and whether the text is stored or searched for | API key in the `x-goog-api-key` header, never in the address |
| `vertexAdapter()` (kind `vertex`) | the same two methods under `projects/{project}/locations/{location}` | `:predict` by default; `settings.embeddingMethod = 'embedContent'` for the newer method | a service-account file; the adapter signs an RS256 statement with `node:crypto`, exchanges it for an access token and keeps the token for its lifetime |

Vertex settings: `project` (required), `publisher` (default `google`), `embeddingMethod` (`predict` or `embedContent`). Gemini setting: `embeddingConfigStyle` (`nested`, the default, or `top-level` for the older field layout).

### Not verified against Google

These adapters were built from Google's public API documents and proved against an in-process fake server (`startFakeGoogleServer` in `@weaveintel/testing`). No request has been sent to Google. In particular, not confirmed against the real services: the nested `embedContentConfig` layout, the largest batch `batchEmbedContents` accepts, the server-sent-event framing of Vertex streaming, whether a rate-limit reply carries `Retry-After`, the model-list address for Vertex, and models that require a "thought signature" to be returned with a tool call (the library's tool-call shape has nowhere to carry one, so tool use with those models may be refused).

## License

MIT.
