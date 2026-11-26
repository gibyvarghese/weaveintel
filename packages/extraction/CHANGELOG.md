# @weaveintel/extraction

## 0.3.1

### Patch Changes

- Updated dependencies [b57835c]
- Updated dependencies [ee6ef7e]
- Updated dependencies [b29c076]
  - @weaveintel/core@0.3.1
  - @weaveintel/connect@0.4.0

## 0.3.0

### Minor Changes

- c4221cc: Mapping proposals speak the shared transform vocabulary. `toMappingRule(transform, field?, samples?)` converts a
  proposal transform (`upper`, `date_dmy`, `number_comma_decimal`, `enum_match`, …) to the one closed list shared by
  `@weaveintel/connect` and `@schemaweave/inbound` (`uppercase`; `date` with `day_first`; `number` with
  `comma_decimal`; `choice_map`). `applyTransform` now reads values with connect's shared readers, so a preview matches
  the saved mapping. **Behaviour changes**: `x` is no longer read as yes; `t`/`f`, `on`/`off`, `checked`/`unchecked`
  are; a two-digit year uses the 1969–2068 window (was always 20xx); numbers read currency signs and accounting brackets.

### Patch Changes

- Updated dependencies [c4221cc]
  - @weaveintel/connect@0.3.0

## 0.2.1

### Patch Changes

- Bring `feat/file-understanding` to `main`, so its packages can be published from here.

  These versions were only ever served from a private registry. npm had `core`, `guardrails`, `routing` and
  `provider-google` under the same or lower numbers but different code, and had no `provider-registry` at all.
  - **core (breaking, hence minor on 0.x).** The strict outbound guard is merged with `main`'s hardened egress.
    - `allowLoopback` now defaults to `false`. Callers that reach this machine opt in; `provider-ollama`,
      `provider-llamacpp` and `a2a` already do.
    - A hostname that does not resolve is refused.
    - One address classifier (`classifyAddress`) is used for literals, resolved addresses and the connect-time pin.
      It also covers CGNAT, NAT64 and the other special ranges.
    - Every request and every redirect hop is pinned with `pinnedFetch` / `pinnedLookup`, and the resolver can be
      supplied with `OutboundUrlPolicy.lookup`.
    - Kept from `main`:
      - A redirect to another origin is refused unless `allowCrossOriginRedirects` is set. It must then be a bodyless
        GET or HEAD, and it carries no caller header at all.
      - Known metadata addresses are refused even when private networks are allowed.
      - `allowInsecureHttp` is available for trusted hosts.
      - `hardenedFetch` keeps the `follow`, `manual` and `error` redirect modes.
    - Also added: capability profiles, a conformance probe and a typed refusal for unreadable content.
  - **extraction:** a file-understanding service with in-house readers, schema-forced extraction and validation, and
    guarded file sources.
  - **routing:** a rule router over plain rows, and filtering on the input capabilities a request needs.
  - **provider-google:** Gemini and Vertex AI as registry adapters.
  - **provider-registry:** new on npm. Model providers as data, with keys fetched per call and a guarded transport.
  - **observability:** the OTLP sink still reaches a collector on this machine (`http://localhost:4318`) by default, now
    that core no longer allows loopback unless asked. Private networks and non-loopback HTTP still need `egressPolicy`.
  - **guardrails, testing and providers:** the file-content fence, the fake provider servers, and file, PDF and audio
    parts that are sent properly or refused by name.

- 7852b9b: Remove regular expressions that could run in quadratic time on hostile files, and make two sanitisers complete.
  - **extraction.** The PDF, HTML, number-mapping, JSON-answer and base-URL code now scans in linear time.
    `htmlToText` removes comments and script/style blocks until none is left, and an unclosed comment or
    script runs to the end of the input, as in a browser. Google Drive folder queries escape backslashes as well as quotes.
  - **guardrails.** `fileSpotlight().wrap` strips forged fence markers until none is left, so cutting one cannot
    join its neighbours into another.

- Updated dependencies
- Updated dependencies [7852b9b]
  - @weaveintel/core@0.3.0
  - @weaveintel/guardrails@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0

## 0.2.0

### Added

- **File understanding** (`createFileUnderstanding`): bytes → sniff → read (parser, OCR, vision or speech) →
  hidden-text stripping and text-layer-vs-OCR check → e-mail attachments (depth-capped) → injection signal →
  classification (types and intents as data) → schema-forced extraction (fields as data, no tools) → validation
  (exact quote in source, OCR cross-check of exact strings, hooks) → provenance per step and per value → cache.
- **Ports**: `DocumentParser`, `Ocr`, `VisionReader`, `SpeechToText`, `FieldExtractor`, `DocumentClassifier`,
  `Embedder`, `ResultCache`.
- **In-house readers**: basic PDF text layer, DOCX, XLSX, e-mail (MIME), text, CSV, HTML; a ZIP reader with
  zip-bomb limits and an XML reader that refuses DOCTYPE.
- **Adapters by injection**: `createPdfJsParser(pdfjs)`, `createPostalMimeParser(PostalMime)`; and
  `createDoclingServeEngine` (docling-serve v1 over the host's guarded fetch; tested against a stand-in server only).
- **Default engines on the core model interfaces**: field extractor, classifier, vision reader, model OCR, speech
  to text, embedder.
- **Spreadsheet column mapping** (`mapColumns`, `applyMapping`, constrained `TRANSFORMS`).
- **Result-cache keys** (`resultCacheKey`, `contentHash`, `createMemoryResultCache`).
- **Stand-in engines** for tests.
- **File sources** (`FileSource` port; identities `user` / `service` / `anonymous`, recorded as `fetchedAs`):
  plain links, Microsoft Graph (OneDrive, SharePoint: share links, content, permissions, delta, live access check),
  Google Drive (download, export of Docs/Sheets/Slides, permissions, changes), Dropbox, Box, an MCP read-file
  tool configured as data, and iCloud public links (no iCloud Drive API exists; stated plainly). A resolver that
  never fetches a link found inside a document, and an on-behalf-of token provider.
- **Guarded transport** (`createGuardedTransport`): https only, public addresses only checked at connect time,
  each redirect hop checked, credentials dropped across origins, size and time limits.

### Dependencies

- Now depends on `@weaveintel/guardrails` (^0.2.1) and `@weaveintel/core` (^0.1.3).
- `pdfjs-dist` and `postal-mime` are OPTIONAL peer dependencies (development dependencies for the tests).
