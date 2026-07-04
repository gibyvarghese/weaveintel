# @weaveintel/extraction

**Runs a document through a pipeline of stages that pull structured data out of messy text — metadata, language, entities, tables, code, tasks, and timelines.**

## Why it exists

A raw document is just a wall of text to a machine — the names, dates, action items, and tables are all in there, but tangled together. Getting them out is like sorting a box of loose paperwork: you don't do it in one sweep, you make passes — first pull the addresses, then the dates, then the invoices. This package is that stack of sorting passes: a configurable pipeline where each stage extracts one kind of structure and hands the growing result to the next, so you turn free text into fields you can actually use.

## When to reach for it

Reach for it to convert unstructured or semi-structured documents into typed results: parsing uploads, mining transcripts for tasks and dates, pulling tables out of reports, or building a knowledge graph of who-relates-to-whom. Compose only the stages you need. If instead you want to *search* a document corpus to answer questions, that's `@weaveintel/retrieval`; extraction is about pulling fields *out*, not fetching passages to read.

## How to use it

```ts
import {
  createDocumentTransformPipeline,
  createMetadataStage,
  createEntityStage,
} from '@weaveintel/extraction';

const pipeline = createDocumentTransformPipeline({
  id: 'intake',
  name: 'Document intake',
  stages: [createMetadataStage(), createEntityStage()],
});

const result = await pipeline.run({ content: reportText, mimeType: 'text/plain' });
console.log(result.metadata, result.entities);
```

## What's in the box

- **Pipeline** — `createDocumentTransformPipeline`, `createEmptyResult`.
- **Stages** — `createMetadataStage`, `createLanguageStage`, `createEntityStage`, `createTableStage`, `createCodeStage`, `createTaskStage`, `createTimelineStage` (each a composable `StageProcessor`).
- **Knowledge graph** — LLM-backed entity/relation extraction for building a notes knowledge graph.
- **Auto-fill** — AI database-column auto-fill with citations.

## License

MIT.
