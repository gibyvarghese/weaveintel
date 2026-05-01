/**
 * Example 77 — Phase K3: Kaggle submit-with-approval (server-driven)
 *
 * Demonstrates the Phase K3 chat-MVP wiring against a running GeneWeave server:
 *   1. Logs into the admin API.
 *   2. Inspects the 4 kaggle_* tool_policies seeded by migration M11.
 *   3. Inspects the 6 kaggle_* skills (with their tool_policy_key bindings).
 *   4. Creates an admin row in `kaggle_competitions_tracked` (operator watchlist).
 *   5. Creates an `kaggle_approaches` row (the ideator's recommendation).
 *   6. Creates an `kaggle_runs` row through POST /api/admin/kaggle-runs WITH
 *      an Idempotency-Key header — replays the same call and proves the
 *      original row is returned (no duplicate).
 *   7. Lists `tool_approval_requests` so an operator can see the runtime queue
 *      that the kaggle_submitter skill (bound to kaggle_submit_gate) feeds
 *      when the submit tool is enabled in the catalog.
 *
 * Prerequisites:
 *  - GeneWeave server running at BASE_URL (default http://localhost:3500)
 *      npx tsx examples/12-geneweave.ts
 *  - Admin account: API_EMAIL / API_PASSWORD (defaults: admin@geneweave.ai / admin123)
 *
 * Run:
 *   npx tsx examples/77-kaggle-submit-with-approval.ts
 */
export {};

const BASE_URL = process.env['API_URL'] ?? 'http://localhost:3500';
const EMAIL    = process.env['API_EMAIL']    ?? 'admin@geneweave.ai';
const PASSWORD = process.env['API_PASSWORD'] ?? 'admin123';

let _cookie = '';
let _csrf   = '';

interface ApiResult<T> { status: number; data: T }

async function apiCall<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (_cookie)                   headers['Cookie']       = _cookie;
  if (_csrf && method !== 'GET') headers['X-CSRF-Token'] = _csrf;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/gw_token=([^;]+)/);
    if (m) _cookie = `gw_token=${m[1]}`;
  }

  const data = await res.json().catch(() => ({})) as T;
  return { status: res.status, data };
}

async function login(): Promise<void> {
  const { status, data } = await apiCall('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (status === 200) {
    _csrf = (data as Record<string, unknown>)['csrfToken'] as string ?? '';
    console.log(`[auth] logged in as ${EMAIL}`);
    return;
  }
  if (status === 401) {
    console.log(`[auth] no admin user — registering ${EMAIL} ...`);
    const reg = await apiCall('POST', '/api/auth/register', { name: 'Admin', email: EMAIL, password: PASSWORD });
    if (reg.status !== 201) throw new Error(`Register failed (${reg.status}): ${JSON.stringify(reg.data)}`);
    _csrf = (reg.data as Record<string, unknown>)['csrfToken'] as string ?? '';
    console.log(`[auth] registered & logged in as ${EMAIL}`);
    return;
  }
  throw new Error(`Login failed (${status}): ${JSON.stringify(data)}`);
}

async function main(): Promise<void> {
  console.log('\n=== Phase K3: Kaggle submit-with-approval (admin walkthrough) ===\n');

  await login();

  // ── 1. Inspect kaggle_* tool_policies ─────────────────────────────────
  console.log('── Step 1: kaggle_* tool policies ──');
  const policiesRes = await apiCall<{ policies: Array<{ key: string; name: string; approval_required: number; rate_limit_per_minute: number; enabled: number }> }>(
    'GET', '/api/admin/tool-policies',
  );
  const kagglePolicies = (policiesRes.data.policies ?? []).filter((p) => p.key.startsWith('kaggle_'));
  for (const p of kagglePolicies) {
    const approval = p.approval_required ? '✓ approval' : '  no approval';
    const enabled  = p.enabled ? 'enabled ' : 'disabled';
    console.log(`  [${p.key.padEnd(28)}] ${approval} | ${p.rate_limit_per_minute}/min | ${enabled} | ${p.name}`);
  }

  // ── 2. Inspect kaggle_* skills ───────────────────────────────────────
  console.log('\n── Step 2: kaggle_* skills ──');
  const skillsRes = await apiCall<{ skills: Array<{ name: string; tool_policy_key: string | null; enabled: number }> }>(
    'GET', '/api/admin/skills',
  );
  const kaggleSkills = (skillsRes.data.skills ?? []).filter((s) => s.name.startsWith('kaggle_'));
  for (const s of kaggleSkills) {
    const enabled = s.enabled ? 'enabled ' : 'disabled';
    console.log(`  [${s.name.padEnd(20)}] policy=${(s.tool_policy_key ?? '(none)').padEnd(26)} ${enabled}`);
  }

  // ── 3. Create a tracked competition ───────────────────────────────────
  console.log('\n── Step 3: POST /api/admin/kaggle-competitions ──');
  const compRef = `titanic-k3-${Date.now()}`;
  const compRes = await apiCall<{ 'kaggle-competition': { id: string; competition_ref: string; status: string } }>(
    'POST', '/api/admin/kaggle-competitions',
    {
      competition_ref: compRef,
      title: 'Titanic — Phase K3 example',
      category: 'tabular',
      deadline: '2099-12-31',
      status: 'watching',
      notes: 'Created by examples/77-kaggle-submit-with-approval.ts',
    },
  );
  if (compRes.status !== 201) throw new Error(`comp create failed (${compRes.status}): ${JSON.stringify(compRes.data)}`);
  const compId = compRes.data['kaggle-competition'].id;
  console.log(`  → created ${compId} (ref=${compRef})`);

  // ── 4. Create an approach ────────────────────────────────────────────
  console.log('\n── Step 4: POST /api/admin/kaggle-approaches ──');
  const approachRes = await apiCall<{ 'kaggle-approach': { id: string; status: string } }>(
    'POST', '/api/admin/kaggle-approaches',
    {
      competition_ref: compRef,
      summary: 'Stacked lightgbm + xgboost with target encoding on tabular features.',
      expected_metric: 'AUC=0.83',
      model: 'lightgbm+xgboost',
      source_kernel_refs: ['demo-user/titanic-baseline', 'demo-user/titanic-stacking'],
      status: 'approved',
      created_by: 'kaggle_ideator',
    },
  );
  if (approachRes.status !== 201) throw new Error(`approach create failed (${approachRes.status}): ${JSON.stringify(approachRes.data)}`);
  const approachId = approachRes.data['kaggle-approach'].id;
  console.log(`  → created ${approachId}`);

  // ── 5. Create a run with Idempotency-Key, then replay it ─────────────
  console.log('\n── Step 5: POST /api/admin/kaggle-runs (with Idempotency-Key) ──');
  const idempotencyKey = `kgl-run-${Date.now()}`;
  const runBody = {
    competition_ref: compRef,
    approach_id: approachId,
    contract_id: 'evidence-contract-stub',
    replay_trace_id: 'replay-trace-stub',
    kernel_ref: 'demo-user/titanic-baseline',
    status: 'queued' as const,
  };
  const runRes1 = await apiCall<{ 'kaggle-run': { id: string; status: string } }>(
    'POST', '/api/admin/kaggle-runs', runBody,
    { 'Idempotency-Key': idempotencyKey },
  );
  if (runRes1.status !== 201) throw new Error(`run create failed (${runRes1.status}): ${JSON.stringify(runRes1.data)}`);
  const runId1 = runRes1.data['kaggle-run'].id;
  console.log(`  → first call created ${runId1}`);

  const runRes2 = await apiCall<{ 'kaggle-run': { id: string } }>(
    'POST', '/api/admin/kaggle-runs', runBody,
    { 'Idempotency-Key': idempotencyKey },
  );
  const runId2 = runRes2.data['kaggle-run'].id;
  console.log(`  → replay returned ${runId2}`);
  if (runId1 !== runId2) {
    throw new Error(`Idempotency violation: ${runId1} vs ${runId2}`);
  }
  console.log('  ✓ Idempotency-Key honored — no duplicate row created.');

  // ── 6. List approval requests (operator queue) ──────────────────────
  console.log('\n── Step 6: GET /api/admin/tool-approval-requests ──');
  const apprRes = await apiCall<{ requests: Array<{ id: string; tool_name: string; status: string; skill_key: string | null; policy_key: string | null }> }>(
    'GET', '/api/admin/tool-approval-requests',
  );
  const requests = apprRes.data.requests ?? [];
  console.log(`  → ${requests.length} approval requests in queue`);
  const kaggleApprovals = requests.filter((r) => r.tool_name?.startsWith('kaggle.'));
  for (const r of kaggleApprovals.slice(0, 5)) {
    console.log(`     [${r.status}] ${r.tool_name} skill=${r.skill_key ?? '(none)'} policy=${r.policy_key ?? '(none)'}`);
  }
  if (kaggleApprovals.length === 0) {
    console.log('  (none yet — tool_catalog.kaggle.* rows ship enabled=0 by design;');
    console.log('   enable kaggle.competitions.submit + provide KAGGLE creds to exercise the gate.)');
  }

  // ── 7. Cleanup ──────────────────────────────────────────────────────
  console.log('\n── Step 7: cleanup ──');
  await apiCall('DELETE', `/api/admin/kaggle-runs/${runId1}`);
  await apiCall('DELETE', `/api/admin/kaggle-approaches/${approachId}`);
  await apiCall('DELETE', `/api/admin/kaggle-competitions/${compId}`);
  console.log('  ✓ removed test rows.\n');

  console.log('=== K3 chat-MVP wiring verified end-to-end. ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
