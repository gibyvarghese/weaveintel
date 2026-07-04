# weaveIntel roadmap

This file holds **forward-looking** plans. Everything in the READMEs, the `/docs` site, and the package
docs describes what exists **today** — no "coming soon", no phase numbers. If you're evaluating weaveIntel,
you don't need to read this; it's a planning note, not a promise.

## How we got here

The framework was consolidated from ~87 tiny packages down to ~44 focused ones (an open-core split:
MIT-licensed `@weaveintel/*` framework packages + the geneWeave community-edition apps). The full,
already-completed old→new package map, the import-rewrite examples, and the reasoning live in
[`MIGRATION.md`](./MIGRATION.md). That work is **done** — it's recorded there as history, not roadmap.

## Under consideration

These are directions we're thinking about, not commitments or dates:

- **Alternative co-editing engines.** `@weaveintel/collab` exposes a `CoeditDoc` port with a
  zero-dependency RGA reference adapter; a Yjs-backed adapter is documented but not yet shipped in-tree.
- **Broader provider coverage.** More first-party model providers behind the same provider interface.
- **Deeper eval + observability integration** across the agent and workflow runtimes.

Have a request? Open an issue — real adopter needs move things up this list.
