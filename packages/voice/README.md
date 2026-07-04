# @weaveintel/voice

**A voice agent pipeline — speech in, an agent turn in the middle, speech out — over a realtime WebSocket, with the same memory, tools, and guardrails as a text agent.**

## Why it exists

Letting someone *talk* to an agent looks simple but hides three moving parts stitched together in real time: turning their speech into text (STT), running the agent, and turning the reply back into audio (TTS) — all while sound is still arriving. It's like simultaneous interpretation at a conference: the interpreter is listening, thinking, and speaking almost at once, and any stall is painfully obvious. This package is that interpreter. It wires the STT→LLM→TTS loop into one pipeline, manages the WebSocket session for a live conversation, and tracks the cost of each turn so a spoken agent behaves exactly like its text counterpart.

## When to reach for it

Reach for it when you're building a server-side voice experience — a phone agent, a talk-to-your-app feature — and want a turn-based pipeline plus a WebSocket handler that keeps parity with your text agents. It runs where `ws` runs (Node and similar server runtimes), not in the browser directly. If you only need the *client* side of a text/agent stream, that's `@weaveintel/client`. If you want raw provider realtime access without the full pipeline, use `VoiceRealtimeProxy` from this package.

## How to use it

```ts
import { VoicePipeline, estimateVoiceTurnCost } from '@weaveintel/voice';

const pipeline = new VoicePipeline({
  send: (msg) => ws.send(JSON.stringify(msg)), // your WebSocket sink
  // ...STT / engine / TTS wiring from your app...
});

const result = await pipeline.runTurn({ audio: incomingPcm });
console.log('reply:', result.text);
console.log('turn cost $', estimateVoiceTurnCost(result.usage));
```

## What's in the box

| Export | What it does |
| --- | --- |
| `VoicePipeline` | The STT→LLM→TTS turn pipeline with streaming callbacks |
| `VoiceWsHandler` | WebSocket session handler for a live voice conversation |
| `VoiceRealtimeProxy`, `computeRealtimeCostUsd`, `REALTIME_PRICING` | Proxy to a provider's realtime API + cost accounting |
| `estimateVoiceTurnCost`, `VOICE_FALLBACK_PRICING`, `ttsFormatToMime` | Cost estimation and audio-format helpers |
| Types | `VoiceConfig`, `VoiceSession`, `VoiceTurnInput`, `VoiceTurnResult`, `VoiceWsClientMessage`, `VoiceWsServerMessage`, and more |

## License

MIT.
