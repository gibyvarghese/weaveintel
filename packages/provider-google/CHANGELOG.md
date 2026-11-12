# @weaveintel/provider-google

## 0.1.3

### Changed

- Gemini parts are sent properly or refused with `UnsupportedContentError`: a part with no content is no
  longer sent as an empty inline blob, file types Gemini does not read (Word, Excel, zip) are refused, and a
  file in a system instruction is refused rather than dropped.
- Vision models declare `PdfInput`, `AudioInput` and `DocumentInput`.

## 0.1.2

### Added

- **`geminiAdapter()`** (kind `gemini`) for `@weaveintel/provider-registry`: chat, streaming, tool use,
  embeddings through `batchEmbedContents` (size and document/query mode), list models and test
  connection. The API key travels in the `x-goog-api-key` header and is fetched per call.
- **`vertexAdapter()`** (kind `vertex`): the same for Vertex AI. Project and location are data; the key
  is a service-account file, from which the adapter signs an RS256 statement with `node:crypto`,
  exchanges it for an access token and keeps the token for its lifetime, keyed by a hash of the file.
  Embeddings go through `:predict`, or `:embedContent` when the provider row says so.
- `googleErrorOverride`: a wrong Gemini key (which Google answers with 400) and a refused
  service-account file are reported as authentication failures.

### Changed

- New dependency on `@weaveintel/provider-registry`. `weaveGoogle`, `weaveGoogleModel` and
  `weaveGoogleConfig` are unchanged.

### Notes

- Built from Google's public API documents and proved against an in-process fake server. Not verified
  against Google: see the README section "Not verified against Google".
- The version is 0.1.2, not 0.2.0, so packages that ask for `^0.1.1` keep resolving it.
