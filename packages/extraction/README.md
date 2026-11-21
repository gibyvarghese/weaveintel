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

## File understanding (0.2.0)

`createFileUnderstanding` takes a file's bytes to a checked result: a normalised document (pages, tables,
attachments, metadata), an optional classification, and optional extracted values, each with a quote, a page, a
confidence and provenance. Nothing is written anywhere: the result is a suggestion for a person to confirm.

```ts
import { createFileUnderstanding, createModelFieldExtractor, createModelClassifier } from '@weaveintel/extraction';
import { createHeuristicInjectionSignal } from '@weaveintel/guardrails';

const fu = createFileUnderstanding({
  pipelineVersion: '2026-11-13',
  extractor: createModelFieldExtractor(claude),   // any core Model; NO tools are ever offered
  classifier: createModelClassifier(claude),
  injectionSignal: createHeuristicInjectionSignal(),
});
const result = await fu.understand(ctx, { bytes, declaredMimeType }, {
  tenantId,
  fields: [{ name: 'total', type: 'number', required: true }],          // data, e.g. from a dictionary
  labels: { types: [{ id: 'invoice', description: 'A bill to pay' }] },  // data
});
```

**Ports** (swap engines by configuration): `DocumentParser`, `Ocr`, `VisionReader`, `SpeechToText`,
`FieldExtractor`, `DocumentClassifier`, `Embedder`, `ResultCache`.

**In-house readers** (no package): PDF text layer (basic: Flate, object streams, ToUnicode), DOCX and XLSX (ZIP
via `node:zlib` with zip-bomb limits, XML with DOCTYPE refused), e-mail (MIME, RFC 2047/2231, nested parts,
depth caps), text, CSV and HTML. **Adapters taking the library by injection** (no dependency): `pdfjs-dist`
(`createPdfJsParser`), `postal-mime` (`createPostalMimeParser`). **Self-hosted engine over HTTP**:
docling-serve (`createDoclingServeEngine`, the host passes its guarded `fetch`).

**Hidden content** is kept out of what the model sees and reported: hidden Word runs, white or tiny text,
comments, deleted tracked changes, hidden sheets/rows/columns, invisible PDF text (render mode 3, white fill,
sub-1pt), invisible HTML, zero-width and Unicode tag characters, and PDF text-layer text that OCR did not see.

**Validation**: values are normalised to their type, checked against enum, pattern and length, their quote is
looked up as an exact string in the document (and in OCR text when an OCR engine is configured), instruction-like
values are flagged, and host validation hooks run last. Each problem lowers the confidence and is listed.

**Spreadsheets**: `mapColumns` maps columns by exact name or alias, then embedding similarity, and asks a model
only about the ambiguous ones, choosing from a fixed list of fields and transforms; `applyMapping` applies it in
code to every row with row-level errors.

**Cache keys**: `resultCacheKey` = tenant + SHA-256 of the bytes + pipeline, schema and model versions. The
tenant is required and comes first.

**Tests**: `createStandInModel`, `createStandInEmbedder`, `createStandInOcr`, `createStandInVision`,
`createStandInSpeech` are deterministic and make no network calls.

## File sources: links and cloud drives

A `FileSource` fetches a file as one identity — `user` (the person's own token; ideally an on-behalf-of
exchange of their sign-in, see `createOnBehalfOfTokenProvider`), `service` (a configured connection) or
`anonymous` — and returns **bytes**, the name, size, version, source URL, the source's permissions normalised
(`sourceAcl`), and `fetchedAs`. Put sources in a `createSourceResolver([...])`; it refuses refs whose origin is
`document`: **a link found inside a file is never fetched automatically**.

All sources go through `createGuardedTransport`: https only, public addresses only (checked inside the
connection's DNS lookup, so no rebinding window), every redirect hop checked, credentials dropped when a
redirect leaves the origin, size and time limits.

| Source | Refs | Identity | List | Changes | ACL | Live access check |
|---|---|---|---|---|---|---|
| `createUrlSource` | https links | anonymous, or per-domain credentials (data) | no | no | no | no |
| `createGraphSource` (OneDrive, SharePoint) | any sharing link, `graph:drives/{d}/items/{i}` | user: delegated (OBO); service: app-only **Sites.Selected** | yes | delta | yes | yes |
| `createGoogleDriveSource` | Drive/Docs/Sheets/Slides links, `gdrive:{id}` | user OAuth; service account that is a member of chosen shared drives | yes | changes.list | yes | yes |
| `createDropboxSource` | shared links, `dropbox:{id or path}` | user OAuth; team token + selected member | yes | list_folder cursor | members | no |
| `createBoxSource` | shared links, `box:{id}` | user OAuth; service account collaborated on folders | yes | no (needs enterprise events) | collaborations | yes |
| `createMcpFileSource` | a configured prefix or host | whatever the MCP server uses | no | no | no | no |
| `createICloudLinkSource` | icloud.com links | anonymous | no | no | no | no |

**iCloud Drive:** Apple offers **no public server API** to read a person's iCloud Drive (CloudKit Web Services
reach only an app's own containers). Two paths are supported, and only these: a public iCloud share link that
serves the file itself (most serve a web page, which is refused with an explanation), or the person downloads the
file in Files or Finder and uploads it.

The base URLs are configurable (national clouds, tests); the tests run every adapter against localhost stand-ins.
