/**
 * Example 113 — Document Extraction Pipeline
 *
 * Runs entirely in-memory. No API keys, no external services, no LLM calls.
 *
 * The problem @weaveintel/extraction solves
 * ─────────────────────────────────────────
 * Raw text arrives from connectors (email, Notion, Confluence, uploaded files)
 * as an unstructured blob. Before an LLM can reason over it effectively, you
 * need to extract structured signals: Who was mentioned? What are the action
 * items? Are there code snippets? What is the doc about?
 *
 * Doing this extraction ad-hoc inside an agent prompt wastes tokens and
 * produces inconsistent results. @weaveintel/extraction decouples extraction
 * into a composable pipeline of StageProcessors that each contribute to a
 * shared ExtractionResult:
 *
 *   • metadata stage  — word count, line count, sentence count, MIME type
 *   • entities stage  — emails, URLs, dates, currencies, phone numbers
 *   • code stage      — fenced code blocks with language annotation
 *   • tasks stage     — TODO/ACTION items and Markdown checklist entries
 *
 * Each stage is independently enable/disable-able, orderable, and testable.
 * The pipeline guarantees all enabled stages run in order and accumulate into
 * a single ExtractionResult with a timing artifact per stage.
 *
 * Packages used:
 *   @weaveintel/extraction — createDocumentTransformPipeline, PipelineOptions,
 *     StageProcessor, createEmptyResult, summarizeResult,
 *     createMetadataStage, createEntityStage, createCodeStage, createTaskStage
 *
 * No API keys needed — all processing is local regex / string analysis.
 *
 * Run: npx tsx examples/113-extraction-pipeline.ts
 */

import {
  // Pipeline factory — assembles ordered StageProcessors into a runnable pipeline
  createDocumentTransformPipeline,
  // Result helpers — create empty result shell and human-readable summary
  createEmptyResult,
  summarizeResult,
  // Stage factories — each produces a StageProcessor with a configurable ExtractionStage
  createMetadataStage,
  createEntityStage,
  createCodeStage,
  createTaskStage,
  // Types
  type PipelineOptions,
  type StageProcessor,
} from '@weaveintel/extraction';

/* ─── Section header helpers ─────────────────────────────────────────────── */

function header(title: string): void {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

function ok(msg: string): void   { console.log(`  ✓ ${msg}`); }
function info(msg: string): void { console.log(`  ℹ ${msg}`); }

/* ─── Realistic document: a meeting-notes memo ───────────────────────────── */

// This document is designed to exercise all four stages simultaneously:
//   - The metadata stage will count words/lines/sentences.
//   - The entities stage will find emails, URLs, dates, and a dollar amount.
//   - The code stage will pick up the TypeScript snippet.
//   - The tasks stage will find the TODO comment inside the snippet and the
//     explicit ACTION lines in the body.
const MEETING_NOTES = `
Meeting Notes — Q3 Planning Session
Date: 2026-05-20
Attendees: Sarah Chen (sarah.chen@acme.corp), Dev Lead
           James Okafor (james.okafor@acme.corp), Product Manager
           Dr. Evelyn Ross (e.ross@research.org), External Advisor

Location: Zoom (https://zoom.us/j/987654321)

─────────────────────────────────────────────────────────────────
AGENDA & DISCUSSION
─────────────────────────────────────────────────────────────────

1. Q3 Budget Review
   Current spend: $42,500 of the $60,000 allocated.
   Sarah confirmed we are on track for the quarter.
   ACTION: James to produce a revised forecast by 2026-06-01.

2. New Feature: Contextual Search
   The team agreed to ship Contextual Search in sprint 14 (starts 2026-06-03).
   Dr. Ross noted that semantic ranking needs at least 80% precision.
   ACTION: Dev team to benchmark retrieval quality this week.

3. Infrastructure Upgrade
   TODO: Migrate the embedding service to the new cluster before June 15.
   The migration guide is posted at https://internal.acme.corp/docs/embed-migration.

   Reference implementation (TypeScript):

\`\`\`typescript
import { createEmbeddingClient } from '@weaveintel/retrieval';

// TODO: replace endpoint once cluster is live
const client = createEmbeddingClient({
  endpoint: 'https://embed.acme.corp/v2',
  model:    'text-embedding-3-large',
  timeout:  5000,
});

export async function embedChunk(text: string): Promise<number[]> {
  const result = await client.embed(text);
  return result.embedding;
}
\`\`\`

4. Upcoming Milestones
   - [ ] Finalize API contract for Contextual Search — due 2026-05-27
   - [x] Complete threat-model review — completed 2026-05-19
   - [ ] Deploy staging environment — contact dev-ops@acme.corp

5. Next Steps
   Reconvene 2026-06-04 at 10:00 AM PST via https://meet.google.com/abc-def-ghi.
   Invite external partners at partners@acme.corp if milestone is hit.
`;

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 1 — Build the pipeline with four stage processors
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstratePipeline(): Promise<void> {
  header('1. Building the Pipeline — Four Stage Processors');

  // createMetadataStage() — counts chars/words/lines/sentences from the raw
  // text. Runs first (order:0) so later stages can rely on metadata existing.
  const metadataStage: StageProcessor = createMetadataStage({
    id:      'metadata',
    enabled: true,
    order:   0,
  });

  // createEntityStage() — uses a set of RegExp patterns to extract emails,
  // URLs, phone numbers, dates, currencies, and percentages.
  // The {types} option narrows which patterns run; omitting it runs all.
  const entitiesStage: StageProcessor = createEntityStage({
    id:      'entities',
    enabled: true,
    order:   2,
    // Only extract email, url, date, and currency entities for this demo.
    types:   ['email', 'url', 'date', 'currency'],
  });

  // createCodeStage() — scans for triple-backtick fenced code blocks and
  // records {language, code} for each match. Works regardless of language tag.
  const codeStage: StageProcessor = createCodeStage({
    id:      'code',
    enabled: true,
    order:   4,
  });

  // createTaskStage() — matches TODO/FIXME/ACTION keyword patterns and
  // Markdown checklist items (- [ ] / - [x]). Produces ExtractedTask entries
  // that an agent can turn into Jira tickets or calendar events.
  const tasksStage: StageProcessor = createTaskStage({
    id:      'tasks',
    enabled: true,
    order:   5,
  });

  info(`Configured ${4} stage processors: metadata, entities, code, tasks`);

  // createDocumentTransformPipeline(opts) assembles stages into an ordered
  // pipeline. The pipeline.run(input) method iterates enabled stages in
  // order, passing the accumulated ExtractionResult from one stage to the
  // next so each stage can append to entities/tasks/codeBlocks/metadata.
  const pipelineOpts: PipelineOptions = {
    id:     'meeting-notes-pipeline',
    name:   'Meeting Notes Extractor',
    stages: [metadataStage, entitiesStage, codeStage, tasksStage],
  };

  const pipeline = createDocumentTransformPipeline(pipelineOpts);
  ok(`Pipeline "${pipeline.name}" (id: ${pipeline.id}) created with ${pipeline.stages.length} stages`);

  // --- Run the pipeline on the meeting-notes document -------------------
  // DocumentInput requires content (string or Buffer) and mimeType.
  // The optional filename is surfaced in the metadata stage's output.
  const result = await pipeline.run({
    content:  MEETING_NOTES,
    mimeType: 'text/plain',
    filename: 'q3-planning-2026-05-20.txt',
  });

  ok('Pipeline.run() completed without errors');
  return result as any;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 2 — Inspect the ExtractionResult field by field
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateResultInspection(): Promise<void> {
  header('2. Inspecting the ExtractionResult');

  // Rebuild the pipeline (same config as above) so this section is self-contained.
  const pipeline = createDocumentTransformPipeline({
    id:     'inspect-pipeline',
    name:   'Inspection Pipeline',
    stages: [
      createMetadataStage({ enabled: true, order: 0 }),
      createEntityStage({ enabled: true, order: 2, types: ['email', 'url', 'date', 'currency'] }),
      createCodeStage({ enabled: true, order: 4 }),
      createTaskStage({ enabled: true, order: 5 }),
    ],
  });

  const result = await pipeline.run({
    content:  MEETING_NOTES,
    mimeType: 'text/plain',
    filename: 'q3-planning-2026-05-20.txt',
  });

  // 2a. Metadata: scalar statistics about the document.
  // These come from createMetadataStage and land in result.metadata.
  info(`--- metadata stage output ---`);
  info(`  charCount:     ${result.metadata['charCount']}`);
  info(`  wordCount:     ${result.metadata['wordCount']}`);
  info(`  lineCount:     ${result.metadata['lineCount']}`);
  info(`  sentenceCount: ${result.metadata['sentenceCount']}`);
  info(`  filename:      ${result.metadata['filename']}`);
  if (!result.metadata['wordCount']) throw new Error('Expected wordCount in metadata');
  ok('metadata stage populated charCount, wordCount, lineCount, sentenceCount, filename');

  // 2b. Entities: structured mentions found by pattern matching.
  // Each ExtractedEntity has text, type, confidence, startOffset, endOffset.
  info(`\n--- entities stage output (${result.entities.length} found) ---`);
  for (const e of result.entities) {
    info(`  [${e.type}] "${e.text}"  confidence=${e.confidence}`);
  }
  const emailEntities = result.entities.filter(e => e.type === 'email');
  const urlEntities   = result.entities.filter(e => e.type === 'url');
  const dateEntities  = result.entities.filter(e => e.type === 'date');
  const currEntities  = result.entities.filter(e => e.type === 'currency');
  info(`  Breakdown: ${emailEntities.length} emails, ${urlEntities.length} URLs, ${dateEntities.length} dates, ${currEntities.length} currencies`);
  if (emailEntities.length === 0) throw new Error('Expected email entities');
  if (urlEntities.length === 0)   throw new Error('Expected URL entities');
  if (dateEntities.length === 0)  throw new Error('Expected date entities');
  ok('entities stage extracted emails, URLs, dates, and currencies');

  // 2c. Code blocks: fenced snippets with language tag and trimmed code.
  // codeBlocks is Array<{language: string; code: string}>.
  const blocks = result.codeBlocks ?? [];
  info(`\n--- code stage output (${blocks.length} block(s)) ---`);
  for (const b of blocks) {
    info(`  language: "${b.language}",  lines: ${b.code.split('\n').length}`);
  }
  if (blocks.length === 0) throw new Error('Expected at least one code block');
  if (blocks[0]?.language !== 'typescript') throw new Error('Expected typescript language tag');
  ok(`code stage found ${blocks.length} fenced code block(s)`);

  // 2d. Tasks: structured action items with priority and optional due date.
  // ExtractedTask has: title, priority, dueDate?, description?, confidence.
  info(`\n--- tasks stage output (${result.tasks.length} task(s)) ---`);
  for (const t of result.tasks) {
    const due = t.dueDate ? ` [due: ${t.dueDate}]` : '';
    const desc = t.description ? ` (${t.description})` : '';
    info(`  [${t.priority}] "${t.title}"${due}${desc}`);
  }
  if (result.tasks.length === 0) throw new Error('Expected task entries');
  ok(`tasks stage extracted ${result.tasks.length} action items and checklist entries`);

  // 2e. Artifacts: timing records — one per stage that actually ran.
  // Each TransformationArtifact has: stageId, type, data, durationMs.
  info(`\n--- stage timing artifacts ---`);
  for (const a of result.artifacts) {
    info(`  stage "${a.stageId}" (${a.type}) — ${a.durationMs.toFixed(2)} ms`);
  }
  if (result.artifacts.length !== 4) throw new Error(`Expected 4 timing artifacts (one per enabled stage), got ${result.artifacts.length}`);
  ok('4 timing artifacts recorded — one per enabled stage');

  // 2f. summarizeResult() — convenience function for a human-readable digest.
  info('\n--- summarizeResult() ---');
  const summary = summarizeResult(result);
  for (const line of summary.split('\n')) info(line);
  ok('summarizeResult() produced a readable digest');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 3 — Disabled stage is skipped
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateDisabledStage(): Promise<void> {
  header('3. Disabled Stage is Skipped — enabled: false');

  // Setting enabled:false on a StageProcessor's ExtractionStage tells the
  // pipeline runner to skip it entirely. This is useful for A/B testing a
  // stage, temporarily disabling an expensive pass, or feature-flagging.
  const pipeline = createDocumentTransformPipeline({
    id:     'partial-pipeline',
    name:   'Partial Pipeline (code disabled)',
    stages: [
      createMetadataStage({ enabled: true,  order: 0 }),
      createEntityStage({ enabled: true,  order: 2 }),
      // Code stage is disabled — should produce no codeBlocks and no artifact.
      createCodeStage({ enabled: false, order: 4 }),
      createTaskStage({ enabled: true,  order: 5 }),
    ],
  });

  info('Running pipeline with code stage disabled (enabled: false)...');
  const result = await pipeline.run({
    content:  MEETING_NOTES,
    mimeType: 'text/plain',
  });

  // The codeBlocks array should be empty because the code stage was skipped.
  const blocks = result.codeBlocks ?? [];
  info(`codeBlocks count: ${blocks.length} (expected 0 — stage was disabled)`);
  if (blocks.length !== 0) throw new Error('Code stage should have been skipped');
  ok('No codeBlocks extracted when code stage is disabled');

  // The artifacts array should have 3 entries (metadata, entities, tasks)
  // because the disabled code stage never ran and therefore recorded no timing.
  info(`Timing artifacts: ${result.artifacts.length} (expected 3 — code stage left no artifact)`);
  const codeArtifact = result.artifacts.find(a => a.stageId === 'code');
  if (codeArtifact !== undefined) throw new Error('Disabled stage should not produce a timing artifact');
  ok('Disabled stage produced no timing artifact — skipped cleanly');

  // The tasks from the other stages still work normally.
  info(`Tasks still extracted by enabled stages: ${result.tasks.length}`);
  ok('Other enabled stages ran normally alongside the disabled stage');
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════════════════════════════════════ */

async function main(): Promise<void> {
  console.log('\n@weaveintel/extraction — Example 113');
  console.log('Document extraction pipeline: metadata, entities, code, tasks');

  await demonstratePipeline();
  await demonstrateResultInspection();
  await demonstrateDisabledStage();

  header('All sections complete');
  console.log('  ✓ Pipeline assembled from four composable StageProcessors');
  console.log('  ✓ ExtractionResult fields inspected: metadata, entities, codeBlocks, tasks, artifacts');
  console.log('  ✓ Disabled stage skipped correctly — no output, no timing artifact');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
