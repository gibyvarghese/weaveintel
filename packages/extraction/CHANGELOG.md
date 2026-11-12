# @weaveintel/extraction

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
