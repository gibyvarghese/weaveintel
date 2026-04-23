/**
 * Example 33 — Tool Simulation Harness (Phase 5)
 *
 * Shows how to use the geneWeave admin Tool Simulation API to:
 *  1. List all tools available for simulation
 *  2. Run a dry-run (policy trace only — no execution)
 *  3. Run a full live simulation and inspect the result
 *
 * The simulation harness is useful for:
 *  - Validating tool policies before enabling tools in production
 *  - Debugging why a tool is being blocked (denied_policy, rate_limit, etc.)
 *  - Regression-testing tool execution output in CI pipelines
 *
 * Prerequisites:
 *  - geneWeave server running at BASE_URL (default: http://localhost:3500)
 *  - A tenant_admin account authenticated via API_EMAIL / API_PASSWORD env vars
 */
export {};

const BASE_URL = process.env['API_URL'] ?? 'http://localhost:3500';
const EMAIL = process.env['API_EMAIL'] ?? 'admin@geneweave.ai';
const PASSWORD = process.env['API_PASSWORD'] ?? 'admin123';

interface PolicyTraceEntry {
  step: string;
  passed: boolean;
  detail: string;
}

interface SimulationResult {
  simulationId: string;
  auditEventId?: string;
  toolName: string;
  dryRun: boolean;
  policy?: unknown;
  policyTrace: PolicyTraceEntry[];
  allowed: boolean;
  violationReason?: string;
  result?: { content: string };
  durationMs: number;
}

let _cookie = '';
let _csrf = '';

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_cookie) headers['Cookie'] = _cookie;
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
  const { status, data } = await apiCall<{ csrfToken?: string }>('POST', '/api/auth/login', {
    email: EMAIL,
    password: PASSWORD,
  });
  if (status !== 200) {
    throw new Error(`Login failed: ${JSON.stringify(data)}`);
  }
  _csrf = (data as Record<string, unknown>)['csrfToken'] as string ?? '';
  console.log('[auth] Logged in as', EMAIL);
}

async function listTools(): Promise<Array<{ key: string; name: string; source: string; description: string }>> {
  const { status, data } = await apiCall<{ tools: Array<{ key: string; name: string; source: string; description: string }> }>(
    'GET', '/api/admin/tool-simulation/tools'
  );
  if (status !== 200) throw new Error(`Failed to list tools: ${status}`);
  return data.tools;
}

async function simulate(toolName: string, input: Record<string, unknown>, dryRun: boolean): Promise<SimulationResult> {
  const { status, data } = await apiCall<SimulationResult>(
    'POST', '/api/admin/tool-simulation',
    { toolName, inputJson: JSON.stringify(input), dryRun }
  );
  if (status !== 200) throw new Error(`Simulation failed (${status}): ${JSON.stringify(data)}`);
  return data;
}

function renderPolicyTrace(trace: PolicyTraceEntry[]): void {
  console.log('\n  Policy Trace:');
  for (const entry of trace) {
    const icon = entry.passed ? '✓' : '✗';
    console.log(`    ${icon} ${entry.step.padEnd(18)} ${entry.detail}`);
  }
}

async function main(): Promise<void> {
  await login();

  // ── 1. List available tools ───────────────────────────────────────────────
  const tools = await listTools();
  console.log(`\n[tools] ${tools.length} tools available for simulation:`);
  for (const t of tools.slice(0, 8)) {
    console.log(`  • ${t.key.padEnd(24)} [${t.source}] ${t.description.slice(0, 60)}`);
  }
  if (tools.length > 8) console.log(`  … and ${tools.length - 8} more`);

  // Pick the calculator tool for the demo (falls back to first available)
  const target = tools.find(t => t.key === 'calculator') ?? tools[0];
  if (!target) {
    console.log('\nNo tools available — is the server running with built-in tools enabled?');
    return;
  }

  // ── 2. Dry-run simulation (policy check only, no execution) ───────────────
  console.log(`\n[dry-run] Simulating '${target.key}' with policy trace only…`);
  const dry = await simulate(target.key, { expression: '6 * 7' }, true);
  console.log(`  simulationId : ${dry.simulationId}`);
  console.log(`  allowed      : ${dry.allowed}`);
  if (dry.violationReason) console.log(`  blocked by   : ${dry.violationReason}`);
  renderPolicyTrace(dry.policyTrace);
  console.log(`  result       : (skipped — dry run)`);
  console.log(`  durationMs   : ${dry.durationMs}ms`);

  // ── 3. Live simulation (executes the tool for real) ───────────────────────
  if (dry.allowed) {
    console.log(`\n[live]    Simulating '${target.key}' with live execution…`);
    const live = await simulate(target.key, { expression: '6 * 7' }, false);
    console.log(`  simulationId : ${live.simulationId}`);
    console.log(`  allowed      : ${live.allowed}`);
    renderPolicyTrace(live.policyTrace);
    console.log(`  result       : ${live.result?.content ?? '(no output)'}`);
    console.log(`  durationMs   : ${live.durationMs}ms`);
  } else {
    console.log('\n[live]    Skipped — policy denied dry-run, live execution would also be blocked.');
  }

  console.log('\n[done] Tool Simulation Harness complete.');
}

main().catch((err) => {
  console.error('[error]', err instanceof Error ? err.message : err);
  process.exit(1);
});
