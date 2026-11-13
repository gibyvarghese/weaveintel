# @weaveintel/provider-llamacpp

## 0.1.3

### Changed

- Says `allowLoopback: true` explicitly: a local llama.cpp server stays reachable under `@weaveintel/core` 0.2.0,
  which makes loopback opt-in. No behaviour change on 0.1.x.

## 0.1.2

### Changed

- A non-text, non-image part is refused with `UnsupportedContentError` instead of becoming placeholder text.
