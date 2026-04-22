import { describe, it, expect } from 'vitest';

const BASE_URL = process.env['SGAP_API_URL'] ?? 'http://localhost:3500';
const RUN_LIVE = process.env['RUN_SGAP_LIVE_TESTS'] === 'true';
const describeLive = RUN_LIVE ? describe : describe.skip;

let cookie = '';
let csrfToken = '';

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/gw_token=([^;]+)/);
    if (match) cookie = `gw_token=${match[1]}`;
  }

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, data };
}

describeLive('SGAP Live API', () => {
  it('executes phase 1 + phase 2 workflow successfully', async () => {
    const email = `sgap-live-${Date.now()}@example.com`;
    const password = 'TestPass123!';

    const register = await api('POST', '/api/auth/register', {
      name: 'SGAP Live Test',
      email,
      password,
    });

    if (register.status === 409) {
      const login = await api('POST', '/api/auth/login', { email, password });
      expect(login.status).toBe(200);
      csrfToken = String(login.data['csrfToken'] ?? '');
    } else {
      expect(register.status).toBe(201);
      csrfToken = String(register.data['csrfToken'] ?? '');
    }

    expect(csrfToken.length).toBeGreaterThan(0);

    const run = await api('POST', '/api/sgap/workflows/675d4a3d-7c6f-4b4b-95c4-2eeb3d0b43f1/run', {
      brand_id: 'a80c1586-f133-4626-b2af-2a945b854f22',
    });
    expect(run.status).toBe(201);

    const runObj = run.data['run'] as Record<string, unknown>;
    const runId = String(runObj?.['id'] ?? '');
    expect(runId.length).toBeGreaterThan(0);

    let phase2 = await api('POST', `/api/sgap/workflow-runs/${runId}/phase2/execute`, {
      max_items: 1,
      content_item_ids: ['7835eb9a-6f09-440b-a875-e4e42d2f40f2'],
    });
    for (let i = 0; i < 2 && phase2.status >= 500; i += 1) {
      phase2 = await api('POST', `/api/sgap/workflow-runs/${runId}/phase2/execute`, {
        max_items: 1,
        content_item_ids: ['7835eb9a-6f09-440b-a875-e4e42d2f40f2'],
      });
    }
    expect(phase2.status).toBe(200);

    const phase2Run = phase2.data['run'] as Record<string, unknown>;
    const phase2Meta = phase2.data['phase2'] as Record<string, unknown>;
    expect(typeof phase2Run?.['status']).toBe('string');
    expect(typeof phase2Run?.['current_stage']).toBe('string');
    expect(Number(phase2Meta?.['revision_count'] ?? 0)).toBeGreaterThan(0);

    const runDetails = await api('GET', `/api/sgap/workflow-runs/${runId}`);
    expect(runDetails.status).toBe(200);
    expect(Array.isArray(runDetails.data['threads'])).toBe(true);
    expect(Array.isArray(runDetails.data['audit'])).toBe(true);

    const cancel = await api('POST', `/api/sgap/workflow-runs/${runId}/cancel`, {});
    expect(cancel.status).toBe(200);

    const cancelled = cancel.data['run'] as Record<string, unknown>;
    expect(cancelled?.['status']).toBe('cancelled');
  }, 90000);

  it('rejects SGAP routes when unauthenticated', async () => {
    const prevCookie = cookie;
    const prevCsrf = csrfToken;
    cookie = '';
    csrfToken = '';

    const run = await api('POST', '/api/sgap/workflows/675d4a3d-7c6f-4b4b-95c4-2eeb3d0b43f1/run', {
      brand_id: 'a80c1586-f133-4626-b2af-2a945b854f22',
    });
    expect(run.status).toBe(401);

    cookie = prevCookie;
    csrfToken = prevCsrf;
  });
});
