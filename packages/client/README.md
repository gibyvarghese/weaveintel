# @weaveintel/client

**A browser-safe client that starts an agent run, streams its progress event-by-event, and keeps working when the network drops.**

## Why it exists

When you ask an AI agent to do something, the answer doesn't arrive all at once — it dribbles in: a bit of text, a tool call, a status update, more text. Think of it like watching a package delivery on a live map instead of just getting a "delivered" text hours later. Your UI needs to render that live trickle without losing its place if the tab refreshes or the Wi-Fi blips. This package is the piece that connects to the server's live stream, folds each little event into one tidy view model your UI can draw, and quietly queues actions in an offline outbox so nothing is lost when you go dark.

## When to reach for it

Reach for it when you're building the client side of an agent UI in the browser (or any JS runtime) and want the wire details — SSE decoding, resume-after-refresh, retry backoff — handled for you. Use the `./react` subpath if you're on React and want ready-made hooks. If you only need to call the geneWeave `/api/me` HTTP endpoints with a bearer token (not raw run streaming), reach for `@weaveintel/api-client` instead, which is built on top of this.

## How to use it

```ts
import { createRunClient, sseTransport, streamReducer, emptyRunViewModel } from '@weaveintel/client';

const client = createRunClient({ transport: sseTransport({ baseUrl: 'https://api.example.com' }) });

let view = emptyRunViewModel();
const run = await client.startRun({ input: 'Summarise my inbox' });

for await (const event of client.attach(run.id)) {
  view = streamReducer(view, event); // fold each event into one drawable view model
  console.log(view.status, view.items.length);
}
```

## What's in the box

| Export | What it does |
| --- | --- |
| `createRunClient` | Start, list, and attach to runs |
| `createRunSession` | Framework-agnostic UX controller: status / stop / regenerate / resume |
| `sseTransport`, `fetchJsonTransport`, `mockSseTransport` | Pluggable transports (live SSE, JSON, and a test double) |
| `parseSseStream` / `SseStallError` | The single byte→event SSE decoder |
| `streamReducer`, `emptyRunViewModel` | Fold streamed events into one `RunViewModel` |
| `parsePartialJson`, `extractJsonCandidate` | Parse structured objects while they're still streaming |
| `createRunControlChannel` | Cancel / steer / presence over a WebSocket control channel |
| `createRunCursorStore`, `isCursorResumable` | Refresh-proof resume cursors |
| `createRunOutbox`, `MemoryStorage` | Offline outbox with backoff + dead-letter |
| `createRunMetrics` | Client-side run observability rollup |
| `toAGUIEvents` | Adapt the stream to AG-UI wire events for ecosystem interop |
| `@weaveintel/client/react` | Optional React hooks (React is an optional peer dependency) |

## License

MIT.
