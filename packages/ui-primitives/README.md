# @weaveintel/ui-primitives

**Builders that produce plain UI event objects — approvals, citations, artifacts, widgets, and streaming envelopes — with no framework attached.**

## Why it exists

An agent doesn't just emit text; it wants to show a table, cite a source, ask "may I run this tool?", or hand you a downloadable file. Every UI framework — React, a mobile shell, a plain-DOM app — needs to agree on *what those things are* before anyone can draw them. This package is the shared vocabulary: it hands you tiny factory functions that return well-formed, sequence-numbered event objects. Think of it as the standard shipping label — it says exactly what's in the box and where it goes, and it doesn't care which truck (framework) carries it. These are pure data, not React components; your renderer decides how they look.

## When to reach for it

Reach for it whenever your server or agent needs to emit structured UI events — approval prompts, citations, artifacts, or interactive widgets — that a client will render. It's framework-agnostic on purpose. If you want the client-side machinery that *consumes* a live run stream (transport, reducer, resume), that's `@weaveintel/client`. If you need accessibility DOM helpers, that's `@weaveintel/a11y`.

## How to use it

```ts
import { createStreamBuilder, tableWidget, documentCitation } from '@weaveintel/ui-primitives';

const stream = createStreamBuilder();
const events = [
  stream.text('Here are your results:'),
  stream.widget(tableWidget({ columns: ['Name', 'Score'], rows: [['Ada', '99']] })),
  stream.citation(documentCitation({ title: 'Q3 Report', quote: 'Revenue rose 12%.' })),
];

for (const evt of events) send(envelope(evt)); // each envelope is a plain, orderable object
```

## What's in the box

| Group | Exports |
| --- | --- |
| Streaming | `createStreamBuilder`, `createUiEvent`, `textEvent`, `errorEvent`, `statusEvent`, `toolCallEvent`, `stepUpdateEvent`, `envelope`, `resetSequence` |
| Approvals | `createApprovalPayload`, `toolApproval`, `workflowApproval` |
| Citations | `createCitation`, `documentCitation`, `webCitation`, `deduplicateCitations` |
| Artifacts | `createArtifactPayload`, `jsonArtifact`, `codeArtifact`, `csvArtifact`, `markdownArtifact` |
| Widgets | `createWidget`, `tableWidget`, `chartWidget`, `formWidget`, `codeWidget`, `timelineWidget`, `imageWidget` |
| Widget actions | `widgetActionEvent`, `parseWidgetAction`, `createWidgetRendererRegistry` |
| Progress | `createProgress`, `createProgressTracker` |

## License

MIT.
