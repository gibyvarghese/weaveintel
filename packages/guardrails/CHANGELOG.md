# @weaveintel/guardrails

## 0.2.2

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
  - @weaveintel/core@0.3.0
  - @weaveintel/persistence@0.1.4

## 0.2.1

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
  - @weaveintel/persistence@0.1.3

### Added

- **Guards for text that came out of a file** (`file-content.ts`):
  - `stripHiddenText`: removes zero-width, bidi, invisible-filler, soft-hyphen and control characters and Unicode
    tag characters, and reports each kind; tag characters are decoded so the hidden ASCII is visible to a reviewer.
  - `compareTextLayers`: a PDF text layer against OCR of the rendered page; a run of words only in the text layer
    (white text, text under an image, tiny fonts) is flagged as a `text_layer_only` finding.
  - `fileSpotlight`: a random per-call fence (`crypto.getRandomValues`) with a file-specific boundary sentence;
    forged boundaries are removed from the content and labels are sanitised (neutral labels only).
  - `InjectionSignal` port (a signal, not a gate), a deterministic `createHeuristicInjectionSignal`, and
    `combineInjectionSignals` (highest score, every hit, a failing engine is reported rather than thrown).

## 0.2.0

### Added

- Tool-result quarantine (GAPS G-WI-2, platform-architecture §7.4 item 10): `quarantineToolResult()`
  fences a result in the run's spotlight fence and withholds one that does not match the tool's
  declared `returns` schema; `validateJsonSchema()` is a dependency-free JSON Schema subset. Subpath
  `@weaveintel/guardrails/tool-quarantine`.
- New Zealand redaction built-ins (G-WI-13, §7.4 item 6): `nz_ird` (check digit and range verified),
  `nz_mobile`, `nz_nhi` (check digit verified for AAANNNC), `nz_passport`; `NZ_PII_PATTERNS`,
  `isValidNzIrd`, `isValidNzNhi`. A built-in can carry a validator, so numbers that fail their check
  digit are left alone.
- `GUARDRAILS_2026` gains "Compliance: NZ PII Redaction" (disabled by default, like the other residency
  rows).
