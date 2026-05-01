/**
 * Example 78 — Phase K4: Kaggle replay round-trip
 *
 * Demonstrates Phase K4 — every Kaggle run becomes a first-class
 * @weaveintel/contracts AgentContract + @weaveintel/replay trace, persisted in
 * `kaggle_run_artifacts`. Operators can then re-execute the exact tool
 * sequence deterministically from the admin API.
 *
 * Flow:
 *   1. Login as admin (registers on first run).
 *   2. POST /api/admin/kaggle-runs/materialize with a fixture RunLog → creates
 *      contract + artifact + projection row in one call.
 *   3. GET /api/admin/kaggle-runs/:id/detail → confirms the join (run +
 *      competition + approach + artifact + contract report preview).
 *   4. POST /api/admin/kaggle-runs/:id/replay → ReplayEngine re-executes the
 *      stored RunLog and returns matchRate=1 because outputs are deterministic.
 *   5. GET /api/admin/kaggle-run-artifacts → confirms the readonly ledger
 *      view returns the artifact preview row.
 *
 * Prereqs:
 *   - GeneWeave server running at BASE_URL (default http://localhost:3500)
 *       OPENAI_API_KEY=dummy-key-for-startup npx tsx examples/12-geneweave.ts
 *   - Admin: API_EMAIL / API_PASSWORD (defaults admin@geneweave.ai / admin123)
 *
 * Run:
 *   npx tsx examples/78-kaggle-replay-roundtrip.ts
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
    method, headers, body: body ? JSON.stringify(body) : undefined,
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
    console.log(`[auth] no admin — registering ${EMAIL} ...`);
    const reg = await apiCall('POST', '/api/auth/register', { name: 'Admin', email: EMAIL, password: PASSWORD });
    if (reg.status !== 201) throw new Error(`Register failed (${reg.status}): ${JSON.stringify(reg.data)}`);
    _csrf = (reg.data as Record<string, unknown>)['csrfToken'] as string ?? '';
    console.log(`[auth] registered & logged in as ${EMAIL}`);
    return;
  }
  throw new Error(`Login failed (${status}): ${JSON.stringify(data)}`);
}

function fixtureRunLog(executionId: string): unknown {
  return {
    executionId,
    startTime: 1700000000000,
    endTime: 1700000001000,
    status: 'completed',
    steps: [
      {
        index: 0, type: 'tool', name: 'kaggle.kernels_push',
        startTime: 1700000000000, endTime: 1700000000400,
        input: { kernelRef: 'demo-user/demo-kernel-78' },
        output: { ok: true },
      },
      {
        index: 1, type: 'tool', name: 'kaggle.competitions_submit',
        startTime: 1700000000400, endTime: 1700000001000,
        input: { competitionRef: 'demo-comp-1' },
        output: { submissionId: 'sub-78', publicScore: 0.901 },
      },
    ],
    totalTokens: 0,
  };
}

async function main(): Promise<void> {
  await login();

  // 1. Materialize a fresh run from a fixture RunLog
  const traceId = `kgl-trace-78-${Date.now()}`;
  const runLog  = fixtureRunLog(traceId);
  const runId   = `kgl-run-78-${Date.now()}`;
  const matRes  = await apiCall<Record<string, unknown>>('POST', '/api/admin/kaggle-runs/materialize', {
    runId,
    competitionRef: 'demo-comp-1',
    kernelRef: 'demo-user/demo-kernel-78',
    submissionCsvSha256: 'a'.repeat(64),
    submissionId: 'sub-78',
    publicScore: 0.901,
    leaderboardJson: { rank: 42, total: 500 },
    validatorReport: { schemaOk: true, rowCount: 1000 },
    status: 'submitted',
    runLog,
  });
  if (matRes.status !== 201) throw new Error(`materialize failed (${matRes.status}): ${JSON.stringify(matRes.data)}`);
  console.log(`[K4 #1] materialized run`, matRes.data);

  // 2. Detail join
  const detail = await apiCall<Record<string, unknown>>('GET', `/api/admin/kaggle-runs/${runId}/detail`);
  if (detail.status !== 200) throw new Error(`detail failed (${detail.status}): ${JSON.stringify(detail.data)}`);
  console.log(`[K4 #2] detail run-log preview:`, detail.data['runLogPreview']);
  console.log(`[K4 #2] detail competition.competition_ref:`, (detail.data['competition'] as Record<string, unknown> | null)?.['competition_ref']);
  console.log(`[K4 #2] artifact id:`, (detail.data['artifact'] as Record<string, unknown> | null)?.['id']);

  // 3. Replay round-trip — match rate should be 1.0 because outputs are pre-baked
  const replay = await apiCall<Record<string, unknown>>('POST', `/api/admin/kaggle-runs/${runId}/replay`);
  if (replay.status !== 200) throw new Error(`replay failed (${replay.status}): ${JSON.stringify(replay.data)}`);
  console.log(`[K4 #3] replay status=${replay.data['status']} matchRate=${replay.data['matchRate']} steps=${(replay.data['steps'] as unknown[]).length}`);
  if (replay.data['matchRate'] !== 1) {
    throw new Error(`Expected matchRate=1, got ${replay.data['matchRate']}`);
  }
  console.log(`[K4 #3] ✓ deterministic replay confirmed`);

  // 4. Artifacts list endpoint
  const list = await apiCall<{ 'kaggle-run-artifacts': unknown[] }>('GET', `/api/admin/kaggle-run-artifacts?limit=10`);
  if (list.status !== 200) throw new Error(`list failed (${list.status}): ${JSON.stringify(list.data)}`);
  console.log(`[K4 #4] artifact list returned ${list.data['kaggle-run-artifacts'].length} previews`);

  console.log(`\n✓ Phase K4 round-trip complete (run=${runId})`);
}

main().catch(e => { console.error(e); process.exit(1); });
