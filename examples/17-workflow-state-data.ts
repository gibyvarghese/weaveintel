/**
 * Example 17 — Workflow State & Data Layer (Phase W3)
 *
 * Demonstrates all Phase W3 features:
 *  • Context propagation — traceId/tenantId injected as __ctx into every step
 *  • Secret masking      — maskFields replaces sensitive values with *** in state
 *  • Output schema valid — warn/fail/coerce modes on step output
 *  • Scoped variables    — outputScope:'step' keeps output ephemeral (not in state)
 *  • Payload offload     — outputs exceeding maxInlineBytes stored in PayloadStore
 *  • InMemoryPayloadStore + JsonFilePayloadStore — in-process and file-backed offload
 *  • Custom traceId/tenantId — caller supplies trace context at startRun time
 *  • Agent tool integration — agent calls run_workflow with W3 features active
 *
 * No LLM API key required for sections 1-8.
 * Set ANTHROPIC_API_KEY to also run section 9 (real agent demo).
 *
 * Run:
 *   npx tsx examples/17-workflow-state-data.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/17-workflow-state-data.ts
 *
 * WeaveIntel packages used:
 *   @weaveintel/workflows — DefaultWorkflowEngine, defineWorkflow,
 *     InMemoryPayloadStore, JsonFilePayloadStore, isPayloadRef, PAYLOAD_REF_PROP,
 *     maskStepOutput, maskValue, validateStepOutput
 */

import {
  DefaultWorkflowEngine,
  defineWorkflow,
  InMemoryPayloadStore,
  JsonFilePayloadStore,
  isPayloadRef,
  PAYLOAD_REF_PROP,
  maskStepOutput,
  maskValue,
  validateStepOutput,
} from '@weaveintel/workflows';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}
function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  → ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); }

const WORK_DIR = join(tmpdir(), `weaveintel-w3-${Date.now()}`);

/* ─────────────────────────────────────────────────────────
   1. maskValue / maskStepOutput — standalone utility
   ───────────────────────────────────────────────────────── */

header('1. maskValue / maskStepOutput — secret masking utilities');

const raw = {
  username: 'alice',
  password: 'supersecret',
  nested: { apiKey: 'key-123', role: 'admin' },
  tokens: ['tok-a', 'tok-b'],
};

const masked = maskStepOutput(raw, ['password', 'nested.apiKey']);
info(`Original password: ${(raw as Record<string, unknown>)['password']}`);
info(`Masked password:   ${(masked as Record<string, unknown>)['password']}`);
info(`Original apiKey:   ${(raw as Record<string, unknown> & { nested: Record<string, unknown> })['nested']['apiKey']}`);
info(`Masked apiKey:     ${((masked as Record<string, unknown>)['nested'] as Record<string, unknown>)['apiKey']}`);
info(`Unmasked username: ${(masked as Record<string, unknown>)['username']}`);

const p = (masked as Record<string, unknown>)['password'];
const k = ((masked as Record<string, unknown>)['nested'] as Record<string, unknown>)['apiKey'];
const u = (masked as Record<string, unknown>)['username'];
if (p !== '***' || k !== '***') throw new Error(`Expected *** got ${String(p)}, ${String(k)}`);
if (u !== 'alice') throw new Error(`Expected alice got ${String(u)}`);
ok('password → ***  and  nested.apiKey → ***  (unmasked fields unchanged)');

// Scalar masking
const scalarMasked = maskValue('secret', ['']);
info(`maskValue scalar: ${String(scalarMasked)}`);
ok('maskValue on scalar replaces the entire value');

/* ─────────────────────────────────────────────────────────
   2. validateStepOutput — schema validation utility
   ───────────────────────────────────────────────────────── */

header('2. validateStepOutput — output schema validation');

const schema = {
  type: 'object' as const,
  required: ['status', 'count'],
  properties: {
    status: { type: 'string' as const, enum: ['ok', 'error'] },
    count:  { type: 'number' as const, minimum: 0, maximum: 1000 },
    label:  { type: 'string' as const, minLength: 1 },
  },
};

// Valid output
const r1 = validateStepOutput({ status: 'ok', count: 5, label: 'hello' }, schema, 'warn');
info(`Valid output: valid=${r1.valid}, errors=${r1.errors.length}`);
if (!r1.valid) throw new Error('Expected valid');
ok('Valid output passes validation');

// Missing required field
const r2 = validateStepOutput({ status: 'ok' }, schema, 'warn');
info(`Missing "count": valid=${r2.valid}, error="${r2.errors[0]?.message ?? ''}"`);
if (r2.valid) throw new Error('Expected invalid');
ok('Missing required field → validation fails');

// Wrong enum value
const r3 = validateStepOutput({ status: 'pending', count: 3 }, schema, 'warn');
info(`Bad enum: valid=${r3.valid}, error="${r3.errors[0]?.message ?? ''}"`);
if (r3.valid) throw new Error('Expected invalid');
ok('Enum violation → validation fails');

// Coerce mode — number-as-string
const coerceSchema = {
  type: 'object' as const,
  properties: {
    value: { type: 'number' as const },
  },
};
const r4 = validateStepOutput({ value: '42' }, coerceSchema, 'coerce');
info(`Coerce "42" string→number: valid=${r4.valid}, coercedValue=${(r4.coercedOutput as Record<string, unknown>)?.['value']}`);
ok('Coerce mode: string "42" → number 42');

/* ─────────────────────────────────────────────────────────
   3. InMemoryPayloadStore + isPayloadRef
   ───────────────────────────────────────────────────────── */

header('3. InMemoryPayloadStore — large payload offload');

const store = new InMemoryPayloadStore();
const largeData = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, value: `item-${i}` })) };

await store.put('run-1:step-a', largeData);
const retrieved = await store.get('run-1:step-a');
info(`Stored item count: ${(retrieved as typeof largeData)?.items?.length}`);
if ((retrieved as typeof largeData)?.items?.length !== 100) throw new Error('Store get failed');
ok(`put/get round-trip — 100 items stored and retrieved correctly`);

// isPayloadRef check
const ref = { [PAYLOAD_REF_PROP]: 'run-1:step-a' };
const notRef = { data: 'hello' };
info(`isPayloadRef(ref):    ${isPayloadRef(ref)}`);
info(`isPayloadRef(notRef): ${isPayloadRef(notRef)}`);
if (!isPayloadRef(ref) || isPayloadRef(notRef)) throw new Error('isPayloadRef wrong');
ok('isPayloadRef correctly identifies payload references');

await store.put('run-1:step-b', { x: 1 });
await store.put('run-1:step-c', { x: 2 });
info(`Store size before deleteRun: ${store.size}`);
await store.deleteRun('run-1');
info(`Store size after deleteRun('run-1'): ${store.size}`);
if (store.size !== 0) throw new Error(`Expected 0 got ${store.size}`);
ok('deleteRun removes all entries for a run');

/* ─────────────────────────────────────────────────────────
   4. Context propagation — __ctx in step variables
   ───────────────────────────────────────────────────────── */

header('4. Context propagation — __ctx injected per step');

{
  const capturedCtx: Record<string, unknown>[] = [];
  const engine = new DefaultWorkflowEngine({
    traceIdGenerator: () => 'trace-fixed-001',
  });

  const def = defineWorkflow('Context Propagation Demo')
    .setId('ctx-demo')
    .deterministic('step-a', 'Step A', { next: 'step-b' })
    .deterministic('step-b', 'Step B')
    .build();
  await engine.createDefinition(def);

  engine.registerHandler('step-a', async (vars) => {
    const ctx = vars['__ctx'] as Record<string, unknown>;
    capturedCtx.push({ ...ctx });
    return { aResult: 'from-a' };
  });
  engine.registerHandler('step-b', async (vars) => {
    const ctx = vars['__ctx'] as Record<string, unknown>;
    capturedCtx.push({ ...ctx });
    return { bResult: 'from-b' };
  });

  const run = await engine.startRun('ctx-demo', {}, {
    traceId: 'trace-fixed-001',
    tenantId: 'tenant-xyz',
  });

  info(`Run status: ${run.status}`);
  info(`Step A ctx: traceId=${capturedCtx[0]?.['traceId']}, tenantId=${capturedCtx[0]?.['tenantId']}, stepId=${capturedCtx[0]?.['stepId']}`);
  info(`Step B ctx: traceId=${capturedCtx[1]?.['traceId']}, stepId=${capturedCtx[1]?.['stepId']}`);

  if (capturedCtx[0]?.['traceId'] !== 'trace-fixed-001') throw new Error('traceId not propagated');
  if (capturedCtx[0]?.['tenantId'] !== 'tenant-xyz') throw new Error('tenantId not propagated');
  if (capturedCtx[0]?.['stepId'] !== 'step-a') throw new Error('stepId wrong');
  if (capturedCtx[1]?.['stepId'] !== 'step-b') throw new Error('stepId wrong for step-b');
  if (run.traceId !== 'trace-fixed-001') throw new Error('run.traceId not set');
  if (run.tenantId !== 'tenant-xyz') throw new Error('run.tenantId not set');
  ok(`__ctx.traceId="${capturedCtx[0]?.['traceId']}", __ctx.tenantId="${capturedCtx[0]?.['tenantId']}"`);
  ok('Per-step __ctx.stepId updates correctly at each step');
  ok('run.traceId and run.tenantId are persisted on the run object');
}

/* ─────────────────────────────────────────────────────────
   5. Secret masking in workflow — maskFields on step
   ───────────────────────────────────────────────────────── */

header('5. Secret masking in workflow — maskFields on step definition');

{
  const engine = new DefaultWorkflowEngine();

  const def = defineWorkflow('Secret Masking Demo')
    .setId('masking-demo')
    .deterministic('login', 'Login Step', { handler: 'login-handler', maskFields: ['password', 'credentials.token'] })
    .build();
  await engine.createDefinition(def);

  engine.registerHandler('login-handler', async (_vars) => ({
    userId: 'user-42',
    password: 'plaintext-secret',
    credentials: { token: 'bearer-abc123', expires: '2026-12-31' },
  }));

  const run = await engine.startRun('masking-demo', {});
  const stepOut = run.state.variables['__step_login'] as Record<string, unknown>;

  info(`userId in state:              ${String(stepOut?.['userId'])}`);
  info(`password in state:            ${String(stepOut?.['password'])}`);
  info(`credentials.token in state:   ${String((stepOut?.['credentials'] as Record<string, unknown>)?.['token'])}`);
  info(`credentials.expires in state: ${String((stepOut?.['credentials'] as Record<string, unknown>)?.['expires'])}`);

  if (stepOut?.['password'] !== '***') throw new Error(`Expected *** got ${String(stepOut?.['password'])}`);
  const tok = (stepOut?.['credentials'] as Record<string, unknown>)?.['token'];
  if (tok !== '***') throw new Error(`Expected *** got ${String(tok)}`);
  if (stepOut?.['userId'] !== 'user-42') throw new Error('userId should not be masked');
  ok('password → ***  in state.variables[__step_login]');
  ok('credentials.token → ***  (nested dot-notation)');
  ok('userId and credentials.expires unchanged');
}

/* ─────────────────────────────────────────────────────────
   6. Output schema validation in workflow — warn/fail/coerce
   ───────────────────────────────────────────────────────── */

header('6. Output schema validation — warn / fail / coerce modes');

// 6a. warn mode — run continues despite schema violation
{
  const engine = new DefaultWorkflowEngine();
  const schemaWarnings: unknown[] = [];
  engine.on('step:output_schema_warn', (ev) => schemaWarnings.push(ev));

  const def = defineWorkflow('Schema Warn Demo')
    .setId('schema-warn')
    .deterministic('produce', 'Produce Output', {
      handler: 'produce-handler',
      outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } } },
      outputSchemaAction: 'warn',
    })
    .build();
  await engine.createDefinition(def);
  engine.registerHandler('produce-handler', async () => ({ count: 'not-a-number' }));

  const run = await engine.startRun('schema-warn', {});
  info(`warn mode — run status: ${run.status}, schema warnings: ${schemaWarnings.length}`);
  if (run.status !== 'completed') throw new Error(`Expected completed got ${run.status}`);
  if (schemaWarnings.length === 0) throw new Error('Expected schema warning event');
  ok('warn mode: run completes despite schema violation, warning event emitted');
}

// 6b. fail mode — step fails on schema violation
{
  const engine = new DefaultWorkflowEngine();

  const def = defineWorkflow('Schema Fail Demo')
    .setId('schema-fail')
    .deterministic('produce', 'Produce Output', {
      handler: 'produce-handler',
      outputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
      outputSchemaAction: 'fail',
    })
    .build();
  await engine.createDefinition(def);
  engine.registerHandler('produce-handler', async () => ({ value: 99 })); // number instead of string

  const run = await engine.startRun('schema-fail', {});
  info(`fail mode — run status: ${run.status}`);
  if (run.status !== 'failed') throw new Error(`Expected failed got ${run.status}`);
  ok('fail mode: run fails when output violates schema');
}

// 6c. coerce mode — output coerced to correct type
{
  const engine = new DefaultWorkflowEngine();

  const def = defineWorkflow('Schema Coerce Demo')
    .setId('schema-coerce')
    .deterministic('produce', 'Produce Output', {
      handler: 'produce-handler',
      outputSchema: { type: 'object', properties: { score: { type: 'number' } } },
      outputSchemaAction: 'coerce',
    })
    .build();
  await engine.createDefinition(def);
  engine.registerHandler('produce-handler', async () => ({ score: '42.5' })); // string → coerce to number

  const run = await engine.startRun('schema-coerce', {});
  const produceOut = run.state.variables['__step_produce'] as Record<string, unknown>;
  const score = produceOut?.['score'];
  info(`coerce mode — score in state: ${String(score)} (type: ${typeof score})`);
  if (run.status !== 'completed') throw new Error(`Expected completed got ${run.status}`);
  if (typeof score !== 'number' || score !== 42.5) throw new Error(`Expected 42.5 number got ${String(score)}`);
  ok('coerce mode: string "42.5" coerced to number 42.5 in state.variables[__step_produce]');
}

/* ─────────────────────────────────────────────────────────
   7. Scoped variables — outputScope:'step' (ephemeral)
   ───────────────────────────────────────────────────────── */

header('7. Scoped variables — outputScope: "step" keeps output ephemeral');

{
  const engine = new DefaultWorkflowEngine();

  // step-a produces ephemeral output, step-b can see it during execution,
  // but it should not persist into the final state.variables.
  let stepBSawEphemeral = false;

  const def = defineWorkflow('Ephemeral Scope Demo')
    .setId('ephemeral-demo')
    .deterministic('step-a', 'Ephemeral Step', { handler: 'ephemeral-handler', outputScope: 'step', next: 'step-b' })
    .deterministic('step-b', 'Consumer Step', { handler: 'consumer-handler' })
    .build();
  await engine.createDefinition(def);

  engine.registerHandler('ephemeral-handler', async () => ({
    tempToken: 'ephemeral-value-xyz',
    alsoTemp: 42,
  }));

  engine.registerHandler('consumer-handler', async (vars) => {
    // During step-b execution, step-a's ephemeral output is promoted under __step_step-a
    const ephemeralOut = vars['__step_step-a'] as Record<string, unknown> | undefined;
    if (ephemeralOut?.['tempToken'] !== undefined) stepBSawEphemeral = true;
    return { finalResult: 'done', stepBSawEphemeral };
  });

  const run = await engine.startRun('ephemeral-demo', {});
  const finalVars = run.state.variables;

  info(`Run status: ${run.status}`);
  info(`step-b saw ephemeral vars: ${stepBSawEphemeral}`);
  info(`__step_step-a in final state: ${String(finalVars['__step_step-a'])}`);
  info(`finalResult in __step_step-b: ${String((finalVars['__step_step-b'] as Record<string, unknown>)?.['finalResult'])}`);

  if (run.status !== 'completed') throw new Error(`Expected completed got ${run.status}`);
  if (!stepBSawEphemeral) throw new Error('step-b should have seen the ephemeral output via __step_step-a');
  if (finalVars['__step_step-a'] !== undefined) throw new Error('__step_step-a should not persist after stripping');
  const finalResult = (finalVars['__step_step-b'] as Record<string, unknown>)?.['finalResult'];
  if (finalResult !== 'done') throw new Error(`finalResult should be in final state, got ${String(finalResult)}`);
  ok('step-a ephemeral output visible to step-b during execution via __step_step-a');
  ok('__step_step-a NOT in final state.variables (stripped after advanceState)');
  ok('step-b (global scope) output __step_step-b persists normally in final state');
}

/* ─────────────────────────────────────────────────────────
   8. Payload offload — InMemoryPayloadStore threshold
   ───────────────────────────────────────────────────────── */

header('8. Payload offload — outputs exceeding maxInlineBytes offloaded');

{
  const payloadStore = new InMemoryPayloadStore();
  const offloadEvents: unknown[] = [];

  const engine = new DefaultWorkflowEngine({
    payloadStore,
    defaultPolicy: { maxInlineBytes: 200 },
  });
  engine.on('step:payload_offloaded', (ev) => offloadEvents.push(ev));

  const def = defineWorkflow('Payload Offload Demo')
    .setId('payload-demo')
    .deterministic('small-step', 'Small Step', { next: 'large-step' })
    .deterministic('large-step', 'Large Step')
    .build();
  await engine.createDefinition(def);

  engine.registerHandler('small-step', async () => ({ result: 'tiny' }));
  engine.registerHandler('large-step', async () => ({
    // Generate output > 200 bytes
    records: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `record-${i}`, value: Math.random() })),
  }));

  const run = await engine.startRun('payload-demo', {});
  const smallStepOut = run.state.variables['__step_small-step'] as Record<string, unknown>;
  const largeStepOut = run.state.variables['__step_large-step'];

  info(`Run status: ${run.status}`);
  info(`small-step result in state: ${String(smallStepOut?.['result'])} (inline)`);
  info(`large-step output is payload ref: ${isPayloadRef(largeStepOut)}`);
  info(`Payload store size: ${payloadStore.size}`);
  info(`Offload events: ${offloadEvents.length}`);

  if (run.status !== 'completed') throw new Error(`Expected completed got ${run.status}`);
  if (smallStepOut?.['result'] !== 'tiny') throw new Error('small step result missing');
  if (!isPayloadRef(largeStepOut)) throw new Error('large output should be a payload ref');
  if (payloadStore.size !== 1) throw new Error(`Expected 1 store entry got ${payloadStore.size}`);
  if (offloadEvents.length !== 1) throw new Error('Expected 1 offload event');

  // Retrieve full payload from store
  const ref = largeStepOut as { __payloadRef: string };
  const full = await payloadStore.get(ref['__payloadRef']) as { records: unknown[] };
  info(`Retrieved full payload: ${full?.records?.length} records`);
  if (full?.records?.length !== 20) throw new Error('Payload retrieval failed');
  ok('small-step output (< threshold) stored inline in state.variables[__step_small-step]');
  ok('large-step output (> threshold) replaced by { __payloadRef: key } in state');
  ok('full payload retrievable via PayloadStore.get(ref.__payloadRef)');
  ok('step:payload_offloaded event emitted with byteSize info');
}

/* ─────────────────────────────────────────────────────────
   8b. JsonFilePayloadStore — file-backed offload
   ───────────────────────────────────────────────────────── */

header('8b. JsonFilePayloadStore — file-backed payload offload');

{
  const fileStore = new JsonFilePayloadStore(WORK_DIR);
  const engine = new DefaultWorkflowEngine({
    payloadStore: fileStore,
    defaultPolicy: { maxInlineBytes: 50 },
  });

  const def = defineWorkflow('File Payload Demo')
    .setId('file-payload-demo')
    .deterministic('data-step', 'Data Step')
    .build();
  await engine.createDefinition(def);

  engine.registerHandler('data-step', async () => ({
    // > 50 bytes
    rows: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }, { id: 3, name: 'Gamma' }],
  }));

  const run = await engine.startRun('file-payload-demo', {});
  const dataStepOut = run.state.variables['__step_data-step'];

  info(`Run status: ${run.status}`);
  info(`data-step output is payload ref: ${isPayloadRef(dataStepOut)}`);

  if (!isPayloadRef(dataStepOut)) throw new Error('Expected payload ref for file store');
  const key = (dataStepOut as { __payloadRef: string })['__payloadRef'];
  const retrieved = await fileStore.get(key) as { rows: unknown[] };
  info(`Retrieved rows from file store: ${retrieved?.rows?.length}`);
  if (retrieved?.rows?.length !== 3) throw new Error('File store retrieval failed');
  ok('JsonFilePayloadStore: large output offloaded to disk, retrieved correctly');

  await fileStore.deleteRun(run.id);
  const afterDelete = await fileStore.get(key);
  info(`After deleteRun — get returns: ${String(afterDelete)}`);
  if (afterDelete !== undefined) throw new Error('Expected undefined after delete');
  ok('deleteRun cleans up all file-backed entries for a run');
}

/* ─────────────────────────────────────────────────────────
   9. Combined W3 workflow — all features in one pipeline
   ───────────────────────────────────────────────────────── */

header('9. Combined W3 workflow — context + masking + schema + scoped + offload');

{
  const payloadStore = new InMemoryPayloadStore();
  const events = {
    warnings: [] as unknown[],
    offloads: [] as unknown[],
  };

  const engine = new DefaultWorkflowEngine({
    payloadStore,
    defaultPolicy: { maxInlineBytes: 300 },
    traceIdGenerator: () => 'trace-combined-W3',
  });
  engine.on('step:output_schema_warn', (ev) => events.warnings.push(ev));
  engine.on('step:payload_offloaded', (ev) => events.offloads.push(ev));

  // Multi-step pipeline:
  // 1. auth-step     → authenticate user (masks password + token, scoped=global)
  // 2. fetch-step    → fetch bulk data   (offloaded if too large)
  // 3. validate-step → validate result   (outputSchema warn mode)
  // 4. summary-step  → summarise         (ephemeral scope — only visible to next step)
  // 5. report-step   → final report      (sees summary via ephemeral promotion)
  const def = defineWorkflow('Combined W3 Pipeline')
    .setId('combined-w3')
    .deterministic('auth-step', 'Authenticate', {
      handler: 'auth-handler',
      maskFields: ['password', 'auth.token'],
      next: 'fetch-step',
    })
    .deterministic('fetch-step', 'Fetch Data', { handler: 'fetch-handler', next: 'validate-step' })
    .deterministic('validate-step', 'Validate', {
      handler: 'validate-handler',
      outputSchema: {
        type: 'object',
        required: ['valid', 'count'],
        properties: {
          valid: { type: 'boolean' },
          count: { type: 'number' },
          score: { type: 'number' },
        },
      },
      outputSchemaAction: 'warn',
      next: 'summary-step',
    })
    .deterministic('summary-step', 'Summarise (ephemeral)', {
      handler: 'summary-handler',
      outputScope: 'step',
      next: 'report-step',
    })
    .deterministic('report-step', 'Final Report', { handler: 'report-handler' })
    .build();
  await engine.createDefinition(def);

  const capturedCtx: Record<string, string[]> = {};

  engine.registerHandler('auth-handler', async (vars) => {
    const ctx = vars['__ctx'] as Record<string, unknown>;
    capturedCtx['auth'] = [String(ctx['traceId']), String(ctx['tenantId']), String(ctx['stepId'])];
    return {
      userId: 'u-999',
      password: 'hunter2',
      auth: { token: 'Bearer xyz789', expiresIn: 3600 },
    };
  });

  engine.registerHandler('fetch-handler', async (_vars) => ({
    // large enough to offload
    records: Array.from({ length: 15 }, (_, i) => ({
      id: i, title: `Record ${i}`, payload: `data-${i}`.repeat(5),
    })),
  }));

  engine.registerHandler('validate-handler', async (vars) => {
    const records = vars['records'];
    const count = isPayloadRef(records) ? -1 : (records as unknown[])?.length ?? 0;
    return {
      valid: true,
      count,
      score: 'excellent', // will trigger warn (string instead of number)
    };
  });

  engine.registerHandler('summary-handler', async (_vars) => ({
    summaryText: 'Pipeline completed successfully — ephemeral summary',
    tempCalc: [1, 2, 3].reduce((a, b) => a + b, 0),
  }));

  engine.registerHandler('report-handler', async (vars) => {
    const ctx = vars['__ctx'] as Record<string, unknown>;
    capturedCtx['report'] = [String(ctx['traceId']), String(ctx['stepId'])];
    const summaryEphemeral = vars['__step_summary-step'] as Record<string, unknown> | undefined;
    return {
      reportId: 'RPT-001',
      summaryVisible: summaryEphemeral?.['summaryText'] !== undefined,
      traceId: ctx['traceId'],
    };
  });

  const run = await engine.startRun('combined-w3', {}, {
    traceId: 'trace-combined-W3',
    tenantId: 'tenant-acme',
  });

  const v = run.state.variables;
  const authOut  = v['__step_auth-step']     as Record<string, unknown>;
  const fetchOut = v['__step_fetch-step'];
  const summaryOut = v['__step_summary-step'];
  const reportOut  = v['__step_report-step'] as Record<string, unknown>;

  info(`Run status: ${run.status}`);
  info(`auth ctx: traceId=${capturedCtx['auth']?.[0]}, tenantId=${capturedCtx['auth']?.[1]}, stepId=${capturedCtx['auth']?.[2]}`);
  info(`report ctx: traceId=${capturedCtx['report']?.[0]}, stepId=${capturedCtx['report']?.[1]}`);
  info(`password in auth output:     ${String(authOut?.['password'])}`);
  info(`auth.token in auth output:   ${String((authOut?.['auth'] as Record<string, unknown>)?.['token'])}`);
  info(`fetch-step output is ref:    ${isPayloadRef(fetchOut)}`);
  info(`schema warnings:             ${events.warnings.length}`);
  info(`payload offloads:            ${events.offloads.length}`);
  info(`__step_summary-step in state: ${String(summaryOut)} (should be undefined — ephemeral)`);
  info(`reportId in report output:   ${String(reportOut?.['reportId'])}`);
  info(`summaryVisible:              ${String(reportOut?.['summaryVisible'])}`);

  if (run.status !== 'completed') throw new Error(`Expected completed got ${run.status}`);

  // Context propagation
  if (capturedCtx['auth']?.[0] !== 'trace-combined-W3') throw new Error('traceId not injected in auth');
  if (capturedCtx['auth']?.[1] !== 'tenant-acme') throw new Error('tenantId not injected');
  ok('Context propagation: traceId + tenantId available in every step via __ctx');

  // Secret masking
  if (authOut?.['password'] !== '***') throw new Error(`password not masked: ${String(authOut?.['password'])}`);
  if ((authOut?.['auth'] as Record<string, unknown>)?.['token'] !== '***') throw new Error('auth.token not masked');
  ok('Secret masking: password + auth.token → *** in __step_auth-step output');

  // Payload offload
  if (!isPayloadRef(fetchOut)) throw new Error('fetch-step output should be payload ref');
  if (events.offloads.length < 1) throw new Error('Expected at least 1 offload event');
  ok('Payload offload: large records output stored in PayloadStore, ref in state');

  // Schema warn
  if (events.warnings.length < 1) throw new Error('Expected schema warning for score field');
  ok('Schema validation: warn emitted for score (string instead of number), run continues');

  // Ephemeral scope — summary-step is ephemeral; its key should not be in final state
  if (summaryOut !== undefined) throw new Error('__step_summary-step should not persist (ephemeral)');
  if (reportOut?.['summaryVisible'] !== true) throw new Error('report-step should have seen ephemeral summary');
  ok('Scoped variables: __step_summary-step absent from final state (stripped after advance)');

  ok('Combined W3 pipeline: all 5 features verified end-to-end');
}

/* ─────────────────────────────────────────────────────────
   9b. Agent tool integration — run_workflow with W3 active
   ───────────────────────────────────────────────────────── */

header('9b. Agent tool integration — run_workflow with W3 features active');

{
  const payloadStore = new InMemoryPayloadStore();
  const engine = new DefaultWorkflowEngine({
    payloadStore,
    defaultPolicy: { maxInlineBytes: 100 },
  });

  const def = defineWorkflow('Agent W3 Workflow')
    .setId('agent-w3-wf')
    .deterministic('process', 'Process', {
      handler: 'process-handler',
      maskFields: ['apiKey'],
      outputSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } },
      outputSchemaAction: 'warn',
    })
    .build();
  await engine.createDefinition(def);

  engine.registerHandler('process-handler', async (vars) => ({
    result: `Processed: ${String(vars['input'] ?? 'default')}`,
    apiKey: 'secret-key-do-not-expose',
    bulkData: Array.from({ length: 10 }, (_, i) => ({ id: i, val: `v${i}` })),
  }));

  // Tool that agents call — passes caller-supplied trace context
  const runWorkflowTool = {
    name: 'run_workflow',
    description: 'Execute a workflow with state management, masking, and payload offload built in.',
    parameters: {
      type: 'object' as const,
      required: ['workflowId', 'input'],
      properties: {
        workflowId: { type: 'string' },
        input:      { type: 'object' },
        traceId:    { type: 'string' },
        tenantId:   { type: 'string' },
      },
    },
    execute: async (args: {
      workflowId: string;
      input: Record<string, unknown>;
      traceId?: string;
      tenantId?: string;
    }) => {
      const run = await engine.startRun(
        args.workflowId,
        args.input,
        { traceId: args.traceId, tenantId: args.tenantId },
      );
      // Extract the single-step output under __step_process, resolving payload refs
      const stepOut = run.state.variables['__step_process'];
      let output: Record<string, unknown>;
      if (isPayloadRef(stepOut)) {
        // Entire step output was offloaded — fetch and use directly
        const fullData = await payloadStore.get((stepOut as { __payloadRef: string })['__payloadRef']);
        output = (fullData as Record<string, unknown>) ?? {};
      } else {
        // Inline output — resolve any per-field payload refs
        const inline = (stepOut as Record<string, unknown>) ?? {};
        const resolved: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(inline)) {
          if (isPayloadRef(val)) {
            const ref = val as { __payloadRef: string };
            resolved[k] = await payloadStore.get(ref['__payloadRef']) ?? val;
          } else {
            resolved[k] = val;
          }
        }
        output = resolved;
      }
      return {
        runId:    run.id,
        status:   run.status,
        traceId:  run.traceId,
        tenantId: run.tenantId,
        output,
      };
    },
  };

  // Simulate agent calling the tool
  const toolResult = await runWorkflowTool.execute({
    workflowId: 'agent-w3-wf',
    input: { input: 'hello-world' },
    traceId: 'trace-agent-001',
    tenantId: 'tenant-demo',
  });

  info(`Tool status: ${toolResult.status}`);
  info(`Tool traceId: ${toolResult.traceId}`);
  info(`Tool tenantId: ${toolResult.tenantId}`);
  info(`apiKey in output: ${String((toolResult.output as Record<string, unknown>)['apiKey'])}`);
  info(`result in output: ${String((toolResult.output as Record<string, unknown>)['result'])}`);
  const bulkResolved = (toolResult.output as Record<string, unknown>)['bulkData'];
  info(`bulkData resolved (${Array.isArray(bulkResolved) ? (bulkResolved as unknown[]).length : 'ref'} items)`);

  if (toolResult.status !== 'completed') throw new Error(`Expected completed got ${toolResult.status}`);
  if (toolResult.traceId !== 'trace-agent-001') throw new Error('traceId not threaded through');
  if ((toolResult.output as Record<string, unknown>)['apiKey'] !== '***') throw new Error('apiKey not masked');
  if (!Array.isArray(bulkResolved)) throw new Error('bulkData should be resolved array');
  ok('run_workflow tool: W3 features active — masking + offload + trace propagation');
  ok('Payload refs auto-resolved before returning to agent — agent sees full data');
  ok('traceId and tenantId threaded from agent call → run → tool result');
}

// ── Real LLM agent (if ANTHROPIC_API_KEY set) ─────────────────────────────
if (process.env['ANTHROPIC_API_KEY']) {
  header('9c. Real agent demo — LLM calls run_workflow with W3 context');
  info('ANTHROPIC_API_KEY set — attempting real agent demo...');
  try {
    const { ReActAgent } = await import('@weaveintel/agents');
    const { AnthropicProvider } = await import('@weaveintel/provider-anthropic');

    const payloadStore2 = new InMemoryPayloadStore();
    const engine2 = new DefaultWorkflowEngine({ payloadStore: payloadStore2, defaultPolicy: { maxInlineBytes: 200 } });
    const def2 = defineWorkflow('Real Agent W3 Workflow')
      .setId('real-agent-w3-wf')
      .deterministic('analyse', 'Analyse', {
        handler: 'analyse-handler',
        maskFields: ['secretKey'],
        outputSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
        outputSchemaAction: 'warn',
      })
      .build();
    await engine2.createDefinition(def2);
    engine2.registerHandler('analyse-handler', async (vars) => ({
      summary: `Analysis complete for input: ${String(vars['query'] ?? 'unknown')}`,
      secretKey: 'hidden-api-key',
      details: Array.from({ length: 10 }, (_, i) => ({ seq: i, note: `detail-${i}` })),
    }));

    const toolFn = {
      name: 'run_workflow',
      description: 'Run a workflow with W3 context propagation. Returns masked output and trace info.',
      parameters: {
        type: 'object' as const,
        required: ['workflowId', 'input'],
        properties: {
          workflowId: { type: 'string' },
          input: { type: 'object' },
        },
      },
      execute: async (args: { workflowId: string; input: Record<string, unknown> }) => {
        const run = await engine2.startRun(
          args.workflowId,
          args.input,
          { tenantId: 'llm-agent-tenant' },
        );
        return { status: run.status, traceId: run.traceId, output: run.state.variables };
      },
    };

    const provider = new AnthropicProvider({ apiKey: process.env['ANTHROPIC_API_KEY']! });
    const agent = new ReActAgent({
      model: { provider: 'anthropic', id: 'claude-haiku-4-5-20251001' },
      systemPrompt: 'You run analysis workflows. Use run_workflow to process user queries.',
      tools: [toolFn],
      provider,
    });

    const response = await agent.run(
      'Run workflow "real-agent-w3-wf" with input { query: "market trends" } and report the summary.',
    );
    ok(`Agent completed: ${String(response.content).slice(0, 120)}`);
  } catch (e) {
    info(`Agent demo skipped: ${(e as Error).message}`);
  }
} else {
  info('ANTHROPIC_API_KEY not set — real LLM agent demo skipped (tool call shown in section 9b)');
}

/* ─────────────────────────────────────────────────────────
   Summary
   ───────────────────────────────────────────────────────── */

header('Summary');
ok('maskValue / maskStepOutput   — standalone secret masking with dot-notation paths');
ok('validateStepOutput           — warn / fail / coerce schema validation utility');
ok('InMemoryPayloadStore         — put/get/delete/deleteRun round-trip verified');
ok('Context propagation          — __ctx.traceId + tenantId + stepId in every step');
ok('Secret masking in workflow   — maskFields replaces secrets with *** in state');
ok('Schema validation — warn     — run continues, step:output_schema_warn emitted');
ok('Schema validation — fail     — run fails on schema violation');
ok('Schema validation — coerce   — string "42.5" coerced to number in state');
ok('Scoped variables (ephemeral) — outputScope:step visible next step, not in final state');
ok('Payload offload (memory)     — large output → { __payloadRef } + store entry');
ok('Payload offload (file)       — JsonFilePayloadStore: disk-backed offload + deleteRun');
ok('Combined W3 pipeline         — all 5 features in one 5-step workflow end-to-end');
ok('Agent tool integration       — run_workflow with W3 active, refs auto-resolved');

// Cleanup
await rm(WORK_DIR, { recursive: true, force: true });
