/**
 * Example 72 — anyWeave Phase 4: Task-Aware Routing Admin API
 *
 * Demonstrates the new operator-facing admin endpoints (M15 + M16)
 * that expose the task-aware router through DB-backed CRUD and a
 * preview "simulator" that scores candidate models without affecting
 * production traffic.
 *
 * Endpoints exercised:
 *   GET    /api/admin/task-types
 *   POST   /api/admin/task-types
 *   PUT    /api/admin/task-types/:key
 *   DELETE /api/admin/task-types/:key
 *   GET    /api/admin/capability-scores
 *   GET    /api/admin/capability-scores/heatmap
 *   GET    /api/admin/provider-tool-adapters
 *   GET    /api/admin/task-type-tenant-overrides
 *   GET    /api/admin/routing-decision-traces
 *   POST   /api/admin/routing-simulator
 *
 * The simulator returns ranked candidates with per-dimension breakdown
 * (cost / speed / quality / capability) using the same DB-backed scoring
 * the runtime router uses. With `persist: true` it writes a trace row
 * to `routing_decision_traces` (`inference_source: 'simulator'`).
 *
 * Prereqs:
 *   - GeneWeave server running (default: http://localhost:3501)
 *   - First registered user is auto-promoted to tenant_admin
 *   - `task_types`, `capability_scores`, and `provider_tool_adapters`
 *     should be pre-seeded (they are in the default startup path)
 */

const BASE = process.env['GENEWEAVE_URL'] ?? 'http://localhost:3501';

interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

let cookie = '';
let csrf = '';

async function api<T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = /gw_token=([^;]+)/.exec(setCookie);
    if (m) cookie = `gw_token=${m[1]}`;
  }
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: parsed };
}

function header(label: string): void {
  console.log('\n────────────────────────────────────────');
  console.log(label);
  console.log('────────────────────────────────────────');
}

(async () => {
  header('1. Authenticate as admin');
  const suffix = Math.random().toString(36).slice(2, 8);
  const reg = await api('POST', '/api/auth/register', {
    email: `routing-admin-${suffix}@example.local`,
    password: 'demo-password-12345',
    name: 'Routing Admin Demo',
  });
  if (reg.status !== 201) {
    console.error('Register failed', reg.status, reg.body);
    process.exit(1);
  }
  csrf = reg.body.csrfToken;
  console.log(`  registered ${reg.body.user.email} (persona=${reg.body.user.persona})`);
  if (reg.body.user.persona !== 'tenant_admin') {
    console.log('  → promoting to tenant_admin via direct DB write (demo only)');
    const { execSync } = await import('node:child_process');
    const dbPath = process.env['DATABASE_PATH'] ?? './geneweave.db';
    execSync(`sqlite3 ${dbPath} "UPDATE users SET persona='tenant_admin' WHERE id='${reg.body.user.id}';"`);
  }

  header('2. List task types');
  const tt = await api('GET', '/api/admin/task-types');
  console.log(`  ${tt.body.taskTypes.length} task types registered`);
  for (const t of tt.body.taskTypes.slice(0, 5)) {
    console.log(`    • ${t.task_key.padEnd(28)} category=${t.category}  strategy=${t.default_strategy}`);
  }
  if (tt.body.taskTypes.length > 5) console.log(`    … +${tt.body.taskTypes.length - 5} more`);

  header('3. Create a custom task type');
  const customKey = `demo_routing_${suffix}`;
  const ctt = await api('POST', '/api/admin/task-types', {
    task_key: customKey,
    display_name: 'Demo Routing Task',
    category: 'demo',
    output_modality: 'text',
    default_strategy: 'cost_optimized',
    default_weights: { cost: 0.6, speed: 0.2, quality: 0.15, capability: 0.05 },
    description: 'Cost-prioritised demo task showing custom weights',
  });
  console.log(`  POST → ${ctt.status} (key=${customKey})`);

  header('4. Inspect capability matrix (heatmap)');
  const hm = await api('GET', '/api/admin/capability-scores/heatmap');
  console.log(`  ${hm.body.taskKeys.length} task keys × ${hm.body.models.length} models`);
  // Print a small slice
  const sliceTasks = hm.body.taskKeys.slice(0, 4);
  console.log(`    ${''.padEnd(28)} ${sliceTasks.map((t: string) => t.padEnd(18)).join('')}`);
  for (const m of hm.body.models.slice(0, 5)) {
    const cells = sliceTasks.map((t: string) => {
      const s = m.scores[t];
      return (s != null ? String(s) : '·').padEnd(18);
    }).join('');
    console.log(`    ${(m.provider + '/' + m.model_id).padEnd(28)} ${cells}`);
  }

  header('5. List provider tool adapters');
  const pta = await api('GET', '/api/admin/provider-tool-adapters');
  console.log(`  ${pta.body.adapters.length} adapters`);
  for (const a of pta.body.adapters) {
    console.log(`    • ${a.provider.padEnd(14)} format=${a.tool_format}  enabled=${!!a.enabled}`);
  }

  header('6. Run routing simulator (seeded task with capability scores)');
  // Pick a seeded task that has capability scores so we get real candidates
  const probeTask = tt.body.taskTypes.find((t: any) => t.task_key === 'classification')?.task_key
    ?? tt.body.taskTypes[0].task_key;
  const sim = await api('POST', '/api/admin/routing-simulator', {
    taskKey: probeTask,
    requireTools: true,
  });
  console.log(`  task: ${probeTask}`);
  console.log(`  weight source: ${sim.body.weightSource}`);
  console.log(`  weights: cost=${sim.body.weightsUsed.cost} speed=${sim.body.weightsUsed.speed} quality=${sim.body.weightsUsed.quality} capability=${sim.body.weightsUsed.capability}`);
  console.log(`  ${sim.body.candidates.length} candidates evaluated`);
  console.log(`  ranked:`);
  for (const [i, c] of sim.body.candidates.slice(0, 5).entries()) {
    const tag = i === 0 ? '★' : ' ';
    const cost = c.estimatedCostPer1M != null ? `$${c.estimatedCostPer1M.toFixed(2)}/1M` : '—';
    console.log(`    ${tag} ${(c.provider + '/' + c.modelId).padEnd(28)} overall=${c.overall.toFixed(3)}  ${cost}`);
  }

  header('7. Run simulator with weight override + persist trace');
  const simP = await api('POST', '/api/admin/routing-simulator', {
    taskKey: probeTask,
    weights: { cost: 0.05, speed: 0.05, quality: 0.7, capability: 0.2 },
    persist: true,
  });
  console.log(`  weight source: ${simP.body.weightSource}`);
  console.log(`  winner: ${simP.body.winner ? simP.body.winner.provider + '/' + simP.body.winner.modelId : 'none'}`);
  console.log(`  trace persisted: ${simP.body.traceId}`);

  header('8. Query persisted decision traces');
  const traces = await api('GET', '/api/admin/routing-decision-traces?limit=5');
  console.log(`  ${traces.body.traces.length} most-recent traces`);
  for (const t of traces.body.traces) {
    console.log(`    • ${t.id.slice(0, 8)}…  task=${t.task_key}  model=${t.selected_provider}/${t.selected_model_id}  src=${t.inference_source}`);
  }

  header('9. Cleanup — delete demo task type');
  const del = await api('DELETE', `/api/admin/task-types/${customKey}`);
  console.log(`  DELETE → ${del.status}`);

  console.log('\n✓ Phase 4 admin demo complete.\n');
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
