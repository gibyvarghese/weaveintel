# @weaveintel/local-engines

## 0.1.0

### Added

- **Engine contract** (`LocalEngine`, `EngineAvailability`, `EngineRunRequest`, `EngineRunResult`, `EngineError`,
  `classifyEngineError`).
- **Routing tickets**: `hashFieldList`, `hashChain`, `sealTicket`, `ticketSigningPayload`,
  `createWebCryptoTicketVerifier`, `checkChain`, `verifyTicket` (refusal codes `malformed`, `expired`,
  `field_list_hash_mismatch`, `chain_hash_mismatch`, `no_hosted_end`, `hosted_not_last`,
  `engine_not_allowed_on_shell`, `signature_missing`, `signature_invalid`).
- **Chain walker** `walkChain`, with `fallbackSummary`, `toResultSubmission`, `toHostedFallback`.
- **Capability probe** `probeCapabilities`, `detectChromeBuiltin`, `readDeviceState`, `DEFAULT_DEVICE_POLICY`.
- **Output checks** `validateTaskOutput` for `text.language`, `text.summary.short`, `field.suggest`,
  `record.classify`, `pii.detect`, `text.translate`, `speech.text`; **pinned files** `verifyFileBytes`.
- **Engines**: `createStubEngine`, `createChromeBuiltinEngine` (feature-detected; never run in tests).
