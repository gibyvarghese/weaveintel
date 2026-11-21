# @weaveintel/testing

## 0.1.2

### Patch Changes

- Updated dependencies [766246e]
- Updated dependencies [049a0d2]
  - @weaveintel/core@0.2.0
  - @weaveintel/sandbox@0.1.4
### Added

- **Fake provider servers** (`provider-fakes.ts`): `startFakeOpenAICompatibleServer` (also Azure and
  Databricks path shapes), `startFakeBedrockServer` (Converse, ConverseStream in the binary event-stream
  framing, Titan and Cohere embeddings, model list; checks a bearer key or recomputes the SigV4 signature
  itself) and `startFakeGoogleServer` (Gemini API and Vertex AI, with a token endpoint that verifies the
  signed JWT). Each records its requests and has failure modes: rate limit with a wait, server failure,
  malformed reply, no answer. Helpers `fakeReplyText`, `fakeVector`, `fakeEventStreamMessage`.
