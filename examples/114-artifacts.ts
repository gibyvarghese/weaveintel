/**
 * Example 114 — Artifact Lifecycle: Create, Version, Store, Policy, Reference
 *
 * Runs entirely in-memory. No API keys, no external services, no database.
 *
 * The problem @weaveintel/artifacts solves
 * ─────────────────────────────────────────
 * Agent runs produce outputs: a JSON report, a generated CSV, a code file,
 * a Markdown summary. Without a structured lifecycle, these outputs are lost
 * between runs, cannot be referenced from other agents, and drift in quality
 * as nobody knows which version was approved.
 *
 * @weaveintel/artifacts provides:
 *
 *   CREATE  — createArtifact() stamps every output with a UUIDv7 id, infers
 *             byte size, and records version=1 with a creation timestamp.
 *
 *   VERSION — createArtifactVersion() produces an ArtifactVersion record that
 *             attaches a changelog to a new snapshot of the artifact's data,
 *             so you can roll back or audit every change.
 *
 *   STORE   — createInMemoryArtifactStore() implements the ArtifactStore
 *             interface: save(), get(), list(filter), delete(), getVersions().
 *             The store auto-creates a version-1 entry on every save().
 *
 *   POLICY  — createArtifactPolicy() expresses governance rules: max size,
 *             allowed types, retention window, versioning requirement.
 *             validateArtifact() checks an artifact against the policy and
 *             returns a {valid, violations[]} result. isExpired() computes
 *             whether the artifact is outside the retention window.
 *
 *   REFERENCE — createArtifactReference() creates a lightweight pointer
 *             (artifactId + optional version + optional label) that one
 *             agent can pass to another instead of copying the full payload.
 *             resolveReference() and formatReference() round out the API.
 *
 * Packages used:
 *   @weaveintel/artifacts — createArtifact, createArtifactVersion,
 *     inferMimeType, estimateSize,
 *     createInMemoryArtifactStore,
 *     createArtifactPolicy, validateArtifact, isExpired,
 *     createArtifactReference, resolveReference, formatReference
 *
 * No API keys needed — all logic is in-process.
 *
 * Run: npx tsx examples/114-artifacts.ts
 */

import {
  // Artifact factory and utilities
  createArtifact,
  createArtifactVersion,
  inferMimeType,
  estimateSize,
  // Store
  createInMemoryArtifactStore,
  // Policy
  createArtifactPolicy,
  validateArtifact,
  isExpired,
  // Reference
  createArtifactReference,
  resolveReference,
  formatReference,
  // Types (type-only imports add zero runtime weight)
  type CreateArtifactOptions,
} from '@weaveintel/artifacts';

/* ─── Section header helpers ─────────────────────────────────────────────── */

function header(title: string): void {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

function ok(msg: string): void   { console.log(`  ✓ ${msg}`); }
function info(msg: string): void { console.log(`  ℹ ${msg}`); }
function fail(msg: string): void { console.log(`  ✗ ${msg}`); }

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 1 — createArtifact(): multiple types with field inspection
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateCreateArtifact(): Promise<void> {
  header('1. createArtifact() — Multiple Artifact Types');

  // createArtifact() stamps a new UUIDv7 id (time-ordered, monotonic), sets
  // version=1, computes sizeBytes via estimateSize(), and records createdAt
  // as an ISO-8601 timestamp. No store needed — this is a pure value object.

  // --- 1a. JSON artifact (structured data from an analysis run) ----------
  const jsonData = {
    sentiment:      'positive',
    score:          0.87,
    keyTopics:      ['infrastructure', 'budget', 'Q3 milestone'],
    totalDocuments: 42,
  };

  const jsonArtifact = createArtifact({
    name:     'sentiment-analysis-q3',
    type:     'json',
    mimeType: inferMimeType('json'),  // inferMimeType() maps ArtifactType → MIME string
    data:     jsonData,
    tags:     ['sentiment', 'q3', 'nlp'],
    runId:    'run-001',
    agentId:  'analyst-agent',
  });

  info(`json artifact id:        ${jsonArtifact.id}`);
  info(`json artifact mimeType:  ${jsonArtifact.mimeType}`);
  info(`json artifact sizeBytes: ${jsonArtifact.sizeBytes}`);
  info(`json artifact version:   ${jsonArtifact.version}`);
  info(`json artifact tags:      ${jsonArtifact.tags?.join(', ')}`);
  info(`json artifact createdAt: ${jsonArtifact.createdAt}`);
  if (jsonArtifact.version !== 1) throw new Error('Expected version 1');
  if (!jsonArtifact.id)           throw new Error('Expected a UUIDv7 id');
  ok('JSON artifact created with id, mimeType, sizeBytes, version=1, tags, createdAt');

  // --- 1b. Code artifact (a generated TypeScript file) ------------------
  const codeData = `
export function greet(name: string): string {
  return \`Hello, \${name}! Welcome to WeaveIntel.\`;
}
`.trim();

  const codeArtifact = createArtifact({
    name:     'greet-util.ts',
    type:     'code',
    mimeType: 'text/typescript',
    data:     codeData,
    tags:     ['generated', 'typescript'],
    runId:    'run-001',
    agentId:  'code-gen-agent',
  });

  info(`\ncode artifact id:       ${codeArtifact.id}`);
  info(`code artifact sizeBytes: ${codeArtifact.sizeBytes}`);
  // estimateSize() measures UTF-8 byte length for strings — verify it matches
  const expectedSize = estimateSize(codeData);
  if (codeArtifact.sizeBytes !== expectedSize) {
    throw new Error(`Expected sizeBytes=${expectedSize}, got ${codeArtifact.sizeBytes}`);
  }
  ok(`Code artifact size (${codeArtifact.sizeBytes} bytes) matches estimateSize()`);

  // --- 1c. Markdown artifact (a narrative report) -----------------------
  const mdData = `# Q3 Planning Report\n\n## Summary\nAll milestones on track.\n\n## Next Steps\n- Ship Contextual Search by 2026-06-30\n`;
  const mdArtifact = createArtifact({
    name:     'q3-report.md',
    type:     'markdown',
    mimeType: inferMimeType('markdown'),
    data:     mdData,
    tags:     ['report', 'q3'],
    runId:    'run-002',
  });
  info(`\nmarkdown artifact mimeType: ${mdArtifact.mimeType}`);
  if (mdArtifact.mimeType !== 'text/markdown') throw new Error('Wrong MIME for markdown');
  ok('Markdown artifact created with correct MIME type (text/markdown)');

  // --- 1d. CSV artifact (tabular output from a data agent) --------------
  const csvData = `agent_id,runs,tokens,cost_usd\nanalyst-agent,14,320000,3.20\ncode-gen-agent,7,80000,1.60\n`;
  const csvArtifact = createArtifact({
    name:     'agent-usage-may2026.csv',
    type:     'csv',
    mimeType: inferMimeType('csv'),
    data:     csvData,
    tags:     ['usage', 'billing'],
  });
  info(`\ncsv artifact mimeType: ${csvArtifact.mimeType}`);
  if (csvArtifact.mimeType !== 'text/csv') throw new Error('Wrong MIME for csv');
  ok('CSV artifact created with correct MIME type (text/csv)');

  info('\nAll four artifact types created successfully');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 2 — createArtifactVersion(): adding a second version with changelog
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateVersioning(): Promise<void> {
  header('2. createArtifactVersion() — Version 2 with Changelog');

  // First, create the original artifact (v1).
  const original = createArtifact({
    name:     'sentiment-analysis-q3',
    type:     'json',
    mimeType: inferMimeType('json'),
    data:     { sentiment: 'neutral', score: 0.50 },
  });
  info(`Original artifact id: ${original.id}, version: ${original.version}`);

  // createArtifactVersion() produces an ArtifactVersion record — a standalone
  // snapshot with its own UUIDv7 id, referencing the parent artifact by id.
  // The changelog string is free-text describing what changed and why.
  const updatedData = { sentiment: 'positive', score: 0.87, refinedAt: '2026-05-27T09:00:00Z' };
  const v2 = createArtifactVersion(
    original.id,  // tie this version back to the original artifact
    2,            // explicit version number — caller controls numbering
    updatedData,
    'Re-scored after correcting the negation-handling bug in the sentiment model',
  );

  info(`Version 2 id:          ${v2.id}`);
  info(`Version 2 artifactId:  ${v2.artifactId}`);
  info(`Version 2 version:     ${v2.version}`);
  info(`Version 2 changelog:   "${v2.changelog}"`);
  info(`Version 2 createdAt:   ${v2.createdAt}`);

  if (v2.artifactId !== original.id) throw new Error('Version must reference the original artifact id');
  if (v2.version !== 2)              throw new Error('Expected version 2');
  if (!v2.changelog)                 throw new Error('Expected changelog to be set');
  ok('Version 2 created with correct artifactId back-reference and changelog');

  // ArtifactVersion.data holds the full snapshot so you can reconstruct any
  // past state without storing diffs.
  const v2score = (v2.data as typeof updatedData).score;
  if (v2score !== 0.87) throw new Error('Version data should reflect updated score');
  ok('Version 2 data contains the updated payload (score=0.87)');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 3 — InMemoryArtifactStore: save, get, list (with filter), delete
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateStore(): Promise<void> {
  header('3. createInMemoryArtifactStore() — Save, Get, List, Delete');

  // createInMemoryArtifactStore() returns a fully-typed ArtifactStore
  // backed by two in-memory Maps. The interface matches what a real
  // database-backed implementation would expose, so tests and demos use
  // this and production uses the DB-backed variant without changing callers.
  const store = createInMemoryArtifactStore();

  // --- 3a. save() — note: store.save() takes Omit<Artifact,'id'|'createdAt'>
  // so we do NOT pass an id or createdAt (the store generates them).
  // We use createArtifact() to build a full artifact object, then spread
  // it without id/createdAt for the save call.
  const artA = createArtifact({ name: 'report-A.md', type: 'markdown', mimeType: 'text/markdown', data: '# Report A', tags: ['report'], runId: 'run-10', agentId: 'writer' });
  const artB = createArtifact({ name: 'data-B.json', type: 'json',     mimeType: 'application/json', data: {rows: 42}, tags: ['data'],   runId: 'run-10', agentId: 'analyst' });
  const artC = createArtifact({ name: 'code-C.ts',   type: 'code',     mimeType: 'text/plain',       data: 'export {}',                  runId: 'run-11', agentId: 'coder' });

  // save() generates a new id and createdAt; returns the stored Artifact.
  const savedA = await store.save({ name: artA.name, type: artA.type, mimeType: artA.mimeType, data: artA.data, version: artA.version, tags: artA.tags, runId: artA.runId, agentId: artA.agentId });
  const savedB = await store.save({ name: artB.name, type: artB.type, mimeType: artB.mimeType, data: artB.data, version: artB.version, tags: artB.tags, runId: artB.runId, agentId: artB.agentId });
  const savedC = await store.save({ name: artC.name, type: artC.type, mimeType: artC.mimeType, data: artC.data, version: artC.version, runId: artC.runId, agentId: artC.agentId });

  info(`Saved artifacts: A=${savedA.id.slice(0,8)}…  B=${savedB.id.slice(0,8)}…  C=${savedC.id.slice(0,8)}…`);
  ok('store.save() returned stored artifacts with generated ids');

  // --- 3b. get() — retrieve a single artifact by id --------------------
  const fetched = await store.get(savedB.id);
  if (!fetched) throw new Error('Expected to retrieve artifact B');
  info(`get(B.id) → name="${fetched.name}", type="${fetched.type}"`);
  ok('store.get() returned the correct artifact');

  // --- 3c. list() with type filter ------------------------------------
  // list() accepts an optional filter: {type, runId, agentId, tags[]}.
  // All fields are AND-ed; pass multiple fields to narrow the results.
  const markdownOnly = await store.list({ type: 'markdown' });
  info(`list({type:'markdown'}) → ${markdownOnly.length} artifact(s)`);
  if (markdownOnly.length !== 1 || markdownOnly[0]?.name !== 'report-A.md') {
    throw new Error('Expected only report-A.md for markdown filter');
  }
  ok('list({type:"markdown"}) returned only markdown artifacts');

  // Filter by runId — should return A and B (both from run-10).
  const run10 = await store.list({ runId: 'run-10' });
  info(`list({runId:'run-10'}) → ${run10.length} artifact(s)`);
  if (run10.length !== 2) throw new Error('Expected 2 artifacts for run-10');
  ok('list({runId:"run-10"}) returned both artifacts from that run');

  // Filter by agentId — should return only C.
  const coderOnly = await store.list({ agentId: 'coder' });
  info(`list({agentId:'coder'}) → ${coderOnly.length} artifact(s)`);
  if (coderOnly.length !== 1) throw new Error('Expected 1 artifact from coder agent');
  ok('list({agentId:"coder"}) returned only the coder agent artifact');

  // --- 3d. getVersions() — auto-created version-1 entry ----------------
  // save() automatically records a version-1 ArtifactVersion so version
  // history is always available from the first save, not just after explicit
  // createArtifactVersion() calls.
  const versions = await store.getVersions(savedA.id);
  info(`getVersions(A) → ${versions.length} version(s), first version: ${versions[0]?.version}`);
  if (versions.length !== 1)  throw new Error('Expected auto-created v1 entry');
  if (versions[0]?.version !== 1) throw new Error('Expected version=1');
  ok('getVersions() returns the auto-created v1 entry from save()');

  // --- 3e. delete() — remove artifact (and its versions) ---------------
  await store.delete(savedC.id);
  const afterDelete = await store.get(savedC.id);
  info(`get(C.id) after delete → ${afterDelete}`);
  if (afterDelete !== null) throw new Error('Expected null after delete');
  ok('store.delete() removed artifact C; get() now returns null');

  // Remaining artifacts
  const remaining = await store.list();
  info(`Total remaining artifacts: ${remaining.length} (expected 2)`);
  if (remaining.length !== 2) throw new Error('Expected 2 artifacts remaining after delete');
  ok('Only 2 artifacts remain after deletion of C');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 4 — Artifact policy: create, validate, check expiry
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstratePolicy(): Promise<void> {
  header('4. Artifact Policy — Governance Rules & Validation');

  // createArtifactPolicy() builds an ArtifactPolicy with typed guards:
  //   maxSizeBytes   — byte ceiling for any single artifact
  //   allowedTypes   — whitelist of ArtifactType values (undefined = all)
  //   retentionDays  — how long before isExpired() returns true
  //   requireVersioning — whether callers must version every change
  const strictPolicy = createArtifactPolicy({
    name:             'strict-prod-policy',
    maxSizeBytes:     1024,           // 1 KB — intentionally small for demo
    allowedTypes:     ['json', 'csv'],// only structured data in this context
    retentionDays:    30,
    requireVersioning: true,
  });

  info(`Policy id:   ${strictPolicy.id.slice(0, 8)}…`);
  info(`Policy name: "${strictPolicy.name}"`);
  info(`maxSizeBytes: ${strictPolicy.maxSizeBytes}, retentionDays: ${strictPolicy.retentionDays}`);
  info(`allowedTypes: ${strictPolicy.allowedTypes?.join(', ')}`);
  ok('Policy created via createArtifactPolicy()');

  // --- 4a. validateArtifact() — valid artifact passes ------------------
  const smallJson = createArtifact({
    name: 'tiny.json', type: 'json', mimeType: 'application/json', data: {ok: true},
  });
  const r1 = validateArtifact(smallJson, strictPolicy);
  info(`\nValidate small JSON artifact: valid=${r1.valid}, violations=${r1.violations.length}`);
  if (!r1.valid) throw new Error(`Expected valid, got: ${r1.violations.join('; ')}`);
  ok('Small JSON artifact passes the strict policy');

  // --- 4b. validateArtifact() — oversized artifact fails ---------------
  // Build a string guaranteed to exceed 1024 bytes.
  const bigData = 'x'.repeat(2000);
  const bigArtifact = createArtifact({
    name: 'big.json', type: 'json', mimeType: 'application/json', data: bigData,
  });
  const r2 = validateArtifact(bigArtifact, strictPolicy);
  info(`Validate oversized artifact: valid=${r2.valid}, violations=${r2.violations.length}`);
  info(`  Violation: "${r2.violations[0]}"`);
  if (r2.valid) throw new Error('Expected oversized artifact to fail');
  ok('Oversized artifact correctly flagged as a policy violation');

  // --- 4c. validateArtifact() — wrong type fails -----------------------
  const mdArtifact = createArtifact({
    name: 'report.md', type: 'markdown', mimeType: 'text/markdown', data: '# hello',
  });
  const r3 = validateArtifact(mdArtifact, strictPolicy);
  info(`Validate markdown artifact (not in allowedTypes): valid=${r3.valid}`);
  info(`  Violation: "${r3.violations[0]}"`);
  if (r3.valid) throw new Error('Expected wrong-type artifact to fail');
  ok('Markdown artifact correctly rejected (type not in allowedTypes)');

  // --- 4d. isExpired() — check retention window -----------------------
  // isExpired() computes (now - artifact.createdAt) > retentionDays.
  // A freshly-created artifact should not be expired.
  const freshArtifact = createArtifact({
    name: 'fresh.json', type: 'json', mimeType: 'application/json', data: {fresh: true},
  });
  const freshExpired = isExpired(freshArtifact, strictPolicy);
  info(`\nFresh artifact expired: ${freshExpired} (expected false)`);
  if (freshExpired) throw new Error('Fresh artifact should not be expired');
  ok('isExpired() returns false for a freshly-created artifact');

  // Simulate an old artifact by manually back-dating its createdAt.
  const oldArtifact = {
    ...freshArtifact,
    createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), // 31 days ago
  };
  const oldExpired = isExpired(oldArtifact, strictPolicy);
  info(`31-day-old artifact expired: ${oldExpired} (expected true — past 30-day retention)`);
  if (!oldExpired) throw new Error('31-day-old artifact should be expired under 30-day retention policy');
  ok('isExpired() correctly flags a 31-day-old artifact as past retention');

  // --- 4e. Disabled policy passes everything ---------------------------
  const disabledPolicy = createArtifactPolicy({
    name: 'disabled-policy', allowedTypes: ['json'], maxSizeBytes: 1, enabled: false,
  });
  const r4 = validateArtifact(bigArtifact, disabledPolicy);
  info(`\nDisabled policy validates oversized/wrong-type artifact: valid=${r4.valid}`);
  if (!r4.valid) throw new Error('Disabled policy should let everything through');
  ok('Disabled policy (enabled:false) passes all artifacts without violations');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 5 — ArtifactReference: lightweight pointer + resolve
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateReference(): Promise<void> {
  header('5. createArtifactReference() — Cross-Agent Artifact Pointers');

  // Set up a store and save an artifact so we have a real id to reference.
  const store = createInMemoryArtifactStore();
  const saved = await store.save({
    name: 'analysis-output.json', type: 'json', mimeType: 'application/json',
    version: 1, data: { result: 'done', score: 0.95 },
  });
  info(`Saved artifact id: ${saved.id.slice(0, 8)}…`);

  // createArtifactReference() is intentionally a pure value — no I/O.
  // Agent A creates it, serialises it to a message, and Agent B receives it.
  // The reference contains artifactId + optional version + optional label.
  const ref = createArtifactReference(
    saved.id,
    1,                       // pin to version 1 so future saves don't change meaning
    'initial analysis pass', // human-readable label for logs and UIs
  );

  info(`Reference: ${formatReference(ref)}`);
  if (ref.artifactId !== saved.id) throw new Error('Reference must point to saved artifact id');
  if (ref.version !== 1)           throw new Error('Expected version=1 in reference');
  if (!ref.label)                  throw new Error('Expected label in reference');
  ok('createArtifactReference() created a pointer with artifactId, version, label');

  // formatReference() renders the reference as a canonical string for
  // display in trace logs, error messages, or UI tooltips.
  const formatted = formatReference(ref);
  info(`formatReference(ref): "${formatted}"`);
  if (!formatted.includes('artifact:')) throw new Error('formatReference should include "artifact:" prefix');
  ok('formatReference() produced canonical string representation');

  // resolveReference() fetches the artifact from the store and patches in
  // the correct version's data when a pinned version is specified.
  const resolved = await resolveReference(store, ref);
  if (!resolved) throw new Error('Expected to resolve reference');
  info(`resolveReference(ref) → name="${resolved.name}", version=${resolved.version}, score=${(resolved.data as any).score}`);
  ok('resolveReference() fetched the artifact from the store via the reference');

  // Resolving a non-existent artifact returns null gracefully.
  const nullRef = createArtifactReference('00000000-0000-0000-0000-000000000000');
  const nullResolved = await resolveReference(store, nullRef);
  info(`resolveReference(bad id) → ${nullResolved}`);
  if (nullResolved !== null) throw new Error('Expected null for unknown artifact id');
  ok('resolveReference() returns null for an unknown artifact id — no exception thrown');
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════════════════════════════════════ */

async function main(): Promise<void> {
  console.log('\n@weaveintel/artifacts — Example 114');
  console.log('Artifact lifecycle: create, version, store, policy, reference');

  await demonstrateCreateArtifact();
  await demonstrateVersioning();
  await demonstrateStore();
  await demonstratePolicy();
  await demonstrateReference();

  header('All sections complete');
  console.log('  ✓ createArtifact(): json, code, markdown, csv — id/version/size/tags verified');
  console.log('  ✓ createArtifactVersion(): v2 with changelog and data snapshot');
  console.log('  ✓ createInMemoryArtifactStore(): save, get, list (type/runId/agentId filters), delete');
  console.log('  ✓ createArtifactPolicy() + validateArtifact() + isExpired(): size, type, retention checks');
  console.log('  ✓ createArtifactReference() + resolveReference() + formatReference()');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
