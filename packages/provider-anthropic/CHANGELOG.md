# @weaveintel/provider-anthropic

## 0.1.2

### Changed

- Content parts are sent properly or refused with `UnsupportedContentError`; the placeholder texts
  `[file: name]` and `[audio content not supported by Anthropic]` are gone. Text files (`text/*`) are now sent
  as plain-text `document` blocks; image files as images; audio and Office files are refused naming the
  capability; unsupported image types are refused.
- Claude models with vision now declare `Capabilities.PdfInput` and `DocumentInput`.

### Added

- `anthropicCapabilityProfile(modelId)`, and `partToAnthropicBlock` / `buildAnthropicMessages` are exported.
