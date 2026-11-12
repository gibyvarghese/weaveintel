# @weaveintel/provider-openai

## 0.1.2

### Changed

- Chat content parts are sent properly or refused with `UnsupportedContentError`; the `[file content]`
  placeholder is gone. PDFs go as `file` parts (`file_data`, a neutral file name) on models that read PDFs,
  wav and mp3 audio as `input_audio` on audio-input models; anything else is refused naming the capability.
- `gpt-4o`, `gpt-4.1` and `gpt-5` models declare `PdfInput`; `gpt-4o*-audio*` models declare `AudioInput`.
- Embedding responses carry `dimensions`.

### Added

- `toOpenAIChatPart` is exported.
