# @weaveintel/tools

**One tool library, many integrations — pay only for what you import.** A core tool registry (risk
classification, network guard, health tracking, policy) plus ready-made integrations — Gmail, Google
Calendar/Drive, Slack, IMAP/Outlook, Dropbox/OneDrive, market & alternative data, news, a webhook and a
file-watcher — each behind its own **subpath import** so nothing you don't use ends up in your bundle.

## Why it's one package (the plain version)

This used to be ~20 tiny packages (`@weaveintel/tools-gmail`, `@weaveintel/tools-slack`, …). That is a lot
of packages to publish, version, and discover for what is really one library. So they are now **subpaths**
of a single package. The trick that makes this safe is **tree-shaking**: because the package is marked
side-effect-free and each integration lives behind its own entry point, importing `@weaveintel/tools/gmail`
pulls in *gmail* — not the market-data feed, not Slack, not the other eighteen. (See the
[webpack tree-shaking guide](https://webpack.js.org/guides/tree-shaking/) and
[npm's `exports`/`sideEffects` docs](https://docs.npmjs.com/files/package.json/) for the mechanism.) A test
in this package bundles a single subpath and *proves* the isolation, so it can't silently regress.

## When to reach for it

- **The root** `@weaveintel/tools` — when you're building a tool registry: register tools, classify their
  risk, gate them by policy, guard their network access, track their health.
- **A subpath** `@weaveintel/tools/<name>` — when you want a specific ready-made integration.
- **Heavy or niche integrations stay separate packages** on purpose: `@weaveintel/tools-browser` (drags in
  Playwright) and `@weaveintel/tools-enterprise` (a large, distinct-audience bundle). Import those by their
  own name.

## How to use it

```ts
// The core registry (lean — no integrations pulled in):
import { createToolRegistry, classifyRisk } from '@weaveintel/tools';

// A specific integration — only gmail's code is bundled:
import { gmailTools } from '@weaveintel/tools/gmail';

// The JSON-schema translator + provider adapters:
import { translate } from '@weaveintel/tools/schema';
```

Mix and match — importing `@weaveintel/tools/slack` and `@weaveintel/tools/marketdata` bundles exactly
those two, nothing else.

## The subpaths

| Import | What it is |
|---|---|
| `@weaveintel/tools` | Core registry: risk classification, policy, network guard, health tracking. |
| `@weaveintel/tools/schema` | Tool JSON-schema types + the OpenAI/Anthropic/Google adapter translators. |
| `@weaveintel/tools/http` | A guarded HTTP client for building tools. |
| `@weaveintel/tools/time` | Timers / stopwatch tools. |
| `@weaveintel/tools/search` | Web-search tools. |
| `@weaveintel/tools/gmail`, `/gcal`, `/gdrive` | Google Workspace (mail, calendar, drive). |
| `@weaveintel/tools/imap`, `/outlook`, `/outlook-cal`, `/onedrive` | Mail + Microsoft 365. |
| `@weaveintel/tools/dropbox`, `/slack`, `/webhook`, `/filewatch` | Files, chat, webhooks, file-watching. |
| `@weaveintel/tools/news`, `/social` | News + social feeds. |
| `@weaveintel/tools/marketdata`, `/altdata`, `/broker` | Market data, alternative data, broker execution. |

Each subpath keeps its own tests. Domain-specific verticals (e.g. a Kaggle-competition toolkit, a StatsNZ
MCP server) live in `examples/verticals/`, not here.

## License

MIT.
