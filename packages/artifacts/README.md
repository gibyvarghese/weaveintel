# @weaveintel/artifacts

**Turns things an agent produces — a chart, a report, a code file — into stored, shareable artifacts, with redaction and sensitivity gating before anything leaves the building.**

## Why it exists

When an AI agent generates a spreadsheet or a document, that output needs to become a real, addressable thing: something with an id and a version, that you can store, fetch, and hand to someone else. But not everything is safe to share — a generated report might contain an API key or a customer's email. Think of it as the mailroom: it packages the parcel, stamps a version on it, and screens the contents before it goes out. This package is that mailroom — it models an artifact, stores it, and redacts or blocks content based on how sensitive it is.

## When to reach for it

Reach for it whenever an agent's output should be persisted and possibly shared: generated files, images, code, structured results. Use `redactText` and the policy helpers before publishing anything that could carry secrets or PII. Start with the in-memory store for tests and the SQLite or filesystem backends for real storage. If you only need to remember facts across a conversation, that's `@weaveintel/memory`; artifacts are for the concrete *outputs* you keep and pass on.

## How to use it

```ts
import { createArtifact, createInMemoryArtifactStore, redactText } from '@weaveintel/artifacts';

const store = createInMemoryArtifactStore();

const { text, redactions } = redactText('Deploy key: sk-live-abc123', 'secrets');

const artifact = createArtifact({
  name: 'deploy-notes.txt',
  type: 'document',
  mimeType: 'text/plain',
  data: text, // secret scrubbed before storage
});

await store.save(artifact);
console.log(`stored ${artifact.id}, redacted ${redactions.length} item(s)`);
```

## What's in the box

- **Model** — `createArtifact`, `createArtifactVersion`, `estimateSize`, `inferMimeType`/`detectImageMime`/`inferCodeMime`.
- **Stores** — `createInMemoryArtifactStore`, plus SQLite and filesystem backends via the store factory.
- **Redaction & sensitivity** — `redactText` (secrets/PII levels), `publishPolicyForSensitivity`, and the policy gating helpers.
- **References & streaming** — reference helpers for pointing at artifacts, and streaming helpers for large payloads.

## License

MIT.
