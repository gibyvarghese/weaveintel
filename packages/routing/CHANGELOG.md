# @weaveintel/routing

## 0.1.4

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

- Updated dependencies
  - @weaveintel/core@0.3.0
  - @weaveintel/resilience@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0

## 0.1.3

### Added

- **Routing on what a model can read.** `needsForRequest(request)` turns a model request into route needs:
  one capability per kind of content it carries (`vision`, `pdf`, `audio_in`, `document:<mime>`), plus
  `structured_output` and `tools`. A model that cannot read the content is skipped before any call.
- `RouteTarget.profile`: a capability profile (declared, or measured by core's conformance probe). Its
  features count as well as `capabilities`, and its context size is used when `contextTokens` is not set. A
  `document:text/*` entry matches every text type.
- `SmartModelRouter` takes `profiles` (keyed `providerId:modelId`), and never falls back to a model that cannot
  read the request's content: it throws `UnsupportedContentError` instead.
- Readable names in explanations: "does not support PDF files", "does not support text/csv files".

## 0.1.2

### Added

- **Rule router** (`createRuleRouter`): routes as plain data. Targets (provider and model, capabilities,
  context size, region, prices, typical latency, vector space) and rules (purpose, needs, cost and latency
  ceilings, sticky, ordered steps) may be functions, so a changed row applies on the next request. Each
  step is judged and the reason it was dropped is recorded: switched off, provider or region not allowed,
  missing capability, context too small, over the cost ceiling, too slow, paused after repeated failures.
  `run` fails over down the list, pauses a failing target with the resilience package's circuit breaker,
  and keeps one run on the target that answered it (`affinityKey`, scoped by tenant and rule).
- **Embedding safety**: the first embedding step fixes the route's vector space; a step in a different
  space is never used, and when nothing compatible is left the request fails rather than mixing vectors.
- Every decision carries its candidates as data and one plain sentence.

### Notes

- A request that is invalid, cancelled, blocked by policy or over budget is handed straight back and does
  not count against the model's health. Pass `shouldFailOver` to decide otherwise.
- The breaker keeps time with the system clock, and a target coming back from a pause admits every caller
  until one of them fails.
