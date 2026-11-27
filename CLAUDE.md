# weaveIntel: instructions for Claude (and any coding agent)

weaveIntel is the open, brand-neutral library monorepo (`@weaveintel/*` on npm). Applications consume it; nothing
app-specific lives here (`npm run check:no-app-brand`).

**The full rulebook is [`.github/copilot-instructions.md`](.github/copilot-instructions.md).** It is permanent law for
every change, whichever agent makes it. Read its Definition of Done before writing a new capability. This file adds the
rules that are easiest to forget.

## Examples rule (every library change)

Every change to a published `@weaveintel/*` package ships a **runnable example** that shows an adopter how to use what
changed. "Done" means:

1. **Where:** `examples/packages/<package>.ts` for one package on its own (in memory, no keys, no network). Use
   `examples/use-cases/<scenario>.ts` when several packages compose. Use `examples/with-llm/` only when a real model is
   the point. Update an existing example in place when the change extends it, rather than adding a near-duplicate.
2. **What:** the example uses the **public** entry points only (the package's `exports`, never `src/` paths). It shows
   the new capability in the way you would recommend it. It **asserts** its own results (`node:assert`), so it fails
   loudly when the API drifts. A new subpath, option, vocabulary word or credential kind each appears at least once.
3. **Explained:** a header comment says, in plain language, what the example shows and when to reach for it. The
   example has a row in [`examples/README.md`](examples/README.md).
4. **Checked:**
   - `npm run test:examples` typechecks every example in CI.
   - Run your example with `npx tsx examples/<path>.ts` before you commit.
   - `npm run check:examples-updated` fails a branch whose changeset names a package that no added or changed example
     imports. The only escape is a line in the changeset body, `examples: none @weaveintel/<pkg> — <reason>`, kept
     for patch-only fixes with no API change.
5. **With the changeset:** the example lands in the same PR as the code and its changeset (CONTRIBUTING.md).

## Other rules that bite

- **Changesets:** a change to a published package needs a changeset (`npx changeset`). Releases are automated (see
  VERSIONING.md).
- **No raw network** in packages: use the hardened fetch from `@weaveintel/core` (`npm run check:no-raw-fetch`).
  Pure-logic packages such as `@weaveintel/connect` take the network from the caller (`send`).
- **Open-core boundary:** engines and mechanisms live here. Catalogues, policy, brand and admin UI live in the apps.
- **Dist staleness:** packages resolve each other through `dist/`. Rebuild (`npx turbo build --filter=<pkg>...`, and
  `--force` when tsc errors may be hidden by the cache) before testing a consumer.
