/**
 * Example 37 — SGAP Admin Workflow Run
 *
 * Demonstrates SGAP admin API usage end-to-end:
 *  1) Login
 *  2) Read SGAP brands and workflow templates
 *  3) Run a workflow template
 *  4) Print generated KPI metrics snapshot
 *
 * Requires a running local geneWeave server.
 *
 * Run: npx tsx examples/37-sgap-admin-workflow-run.ts
 */

const BASE_URL = process.env['API_URL'] ?? 'http://localhost:3500';
const EMAIL = process.env['API_EMAIL'];
const PASSWORD = process.env['API_PASSWORD'];

let cookie = '';
let csrfToken = '';

type ApiResult<T> = { status: number; data: T };

async function api<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/gw_token=([^;]+)/);
    if (match) cookie = `gw_token=${match[1]}`;
  }

  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

async function login(): Promise<void> {
  const init = await api<{ csrfToken?: string }>('GET', '/api/init');
  csrfToken = init.data['csrfToken'] ?? '';

  if (!EMAIL || !PASSWORD) {
    throw new Error('Missing API credentials. Set API_EMAIL and API_PASSWORD for an account with SGAP admin access.');
  }

  const loginRes = await api<{ csrfToken?: string; error?: string }>('POST', '/api/auth/login', {
    email: EMAIL,
    password: PASSWORD,
  });

  if (loginRes.status !== 200) {
    throw new Error(
      `Login failed (${loginRes.status}). Ensure API_EMAIL/API_PASSWORD are valid and the account can access /api/admin/sg-* endpoints. `
      + `Server response: ${JSON.stringify(loginRes.data)}`,
    );
  }
  csrfToken = loginRes.data['csrfToken'] ?? csrfToken;
}

async function main() {
  console.log('Logging in...');
  await login();

  const brandsRes = await api<{ 'sg-brands'?: Array<Record<string, unknown>>; error?: string }>('GET', '/api/admin/sg-brands');
  if (brandsRes.status !== 200) {
    throw new Error(`Failed to list brands (${brandsRes.status}): ${JSON.stringify(brandsRes.data)}`);
  }

  const brands = brandsRes.data['sg-brands'] ?? [];
  if (brands.length === 0) {
    throw new Error('No SGAP brands found. Seed data may be missing.');
  }

  const brand = brands.find((b) => b['slug'] === 'tech-lunch') ?? brands[0]!;
  const brandId = String(brand['id']);
  console.log(`Using brand: ${String(brand['name'])} (${brandId})`);

  const wfRes = await api<{ 'sg-workflow-templates'?: Array<Record<string, unknown>>; error?: string }>('GET', '/api/admin/sg-workflow-templates');
  if (wfRes.status !== 200) {
    throw new Error(`Failed to list workflow templates (${wfRes.status}): ${JSON.stringify(wfRes.data)}`);
  }

  const templates = (wfRes.data['sg-workflow-templates'] ?? []).filter((t) => String(t['brand_id']) === brandId);
  if (templates.length === 0) {
    throw new Error(`No workflow templates found for brand ${brandId}.`);
  }

  const template = templates[0]!;
  const templateId = String(template['id']);
  console.log(`Running template: ${String(template['name'])} (${templateId})`);

  const runRes = await api<{ run?: Record<string, unknown>; snapshot?: Record<string, unknown>; metrics?: Record<string, unknown>; error?: string }>(
    'POST',
    `/api/admin/sg-workflow-templates/${templateId}/run`,
    { brand_id: brandId },
  );

  if (runRes.status !== 201) {
    throw new Error(`Workflow run failed (${runRes.status}): ${JSON.stringify(runRes.data)}`);
  }

  console.log('\nWorkflow Run Completed');
  console.log(`Run ID: ${String(runRes.data.run?.['id'] ?? 'n/a')}`);
  console.log(`Snapshot ID: ${String(runRes.data.snapshot?.['id'] ?? 'n/a')}`);
  console.log('Metrics:');
  console.log(JSON.stringify(runRes.data.metrics ?? {}, null, 2));
}

main().catch((err) => {
  console.error('Example failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

export {};
