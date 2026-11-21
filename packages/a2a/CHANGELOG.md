# @weaveintel/a2a

## 0.2.0

### Minor Changes

- 766246e: Add an opt-in authenticated dispatcher for independent A2A 1.0 JSON-RPC
  messages, requiring host authentication and authorization and returning
  sanitized errors for callback failures.
- 766246e: Validate every redirect with hardened egress and reject cross-origin redirects by
  default. The explicit cross-origin opt-in only permits bodyless GET/HEAD requests
  and strips caller headers. Metadata addresses remain blocked when private
  network access is enabled. Trusted hosts can explicitly permit non-loopback HTTP.

  A2A webhooks and OTLP exports now use hardened egress. Private collectors require
  an explicit host policy, and failed OTLP batches are reported instead of being
  silently discarded. Existing cross-origin redirects and private endpoints may
  require configuration changes.

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
