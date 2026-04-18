/**
 * @weaveintel/geneweave — API integration tests
 *
 * Tests run against the deployed Azure API.
 * Requires the server to be running at BASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env['API_URL'] ?? 'https://anyweave-api.livelyrock-3622bbbd.westus2.azurecontainerapps.io';
const RUN_ADMIN_TESTS = process.env['API_TEST_RUN_ADMIN'] === 'true';
const describeAdmin = RUN_ADMIN_TESTS ? describe : describe.skip;

let cookie = '';
let csrfToken = '';
let authChecked = false;
let authAvailable = false;

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

  // Capture Set-Cookie header
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/gw_token=([^;]+)/);
    if (match) cookie = `gw_token=${match[1]}`;
  }

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, data };
}

async function ensureAuthenticated(): Promise<boolean> {
  if (authChecked) return authAvailable;

  const me = await api('GET', '/api/auth/me');
  if (me.status === 200) {
    authAvailable = true;
    authChecked = true;
    return true;
  }

  const email = process.env['API_TEST_EMAIL'];
  const password = process.env['API_TEST_PASSWORD'];
  if (email && password) {
    const login = await api('POST', '/api/auth/login', { email, password });
    if (login.status === 200) {
      csrfToken = login.data['csrfToken'] as string;
      authAvailable = true;
      authChecked = true;
      return true;
    }
  }

  authAvailable = false;
  authChecked = true;
  return false;
}

// ─── Auth ────────────────────────────────────────────────────

describe('Auth', () => {
  const testEmail = `test-${Date.now()}@weaveintel.dev`;
  const testPassword = 'Str0ng!Pass99';

  it('registers a new user', async () => {
    const { status, data } = await api('POST', '/api/auth/register', {
      name: 'Test User',
      email: testEmail,
      password: testPassword,
    });
    if (status === 201) {
      expect(data['user']).toBeDefined();
      expect(data['csrfToken']).toBeDefined();
      csrfToken = data['csrfToken'] as string;
      authChecked = false;
      return;
    }
    expect([401, 403, 409]).toContain(status);
  });

  it('returns current user', async () => {
    const hasAuth = await ensureAuthenticated();
    const { status, data } = await api('GET', '/api/auth/me');
    if (!hasAuth) {
      expect(status).toBe(401);
      return;
    }
    expect(status).toBe(200);
    expect(data['user']).toBeDefined();
  });

  it('logs out and re-logs in', async () => {
    const hadAuth = await ensureAuthenticated();
    await api('POST', '/api/auth/logout');
    cookie = '';
    csrfToken = '';
    authChecked = false;

    let loginStatus = 0;
    let loginData: Record<string, unknown> = {};
    const primaryLogin = await api('POST', '/api/auth/login', {
      email: testEmail,
      password: testPassword,
    });
    loginStatus = primaryLogin.status;
    loginData = primaryLogin.data;

    if (loginStatus !== 200) {
      const envEmail = process.env['API_TEST_EMAIL'];
      const envPassword = process.env['API_TEST_PASSWORD'];
      if (envEmail && envPassword) {
        const fallbackLogin = await api('POST', '/api/auth/login', { email: envEmail, password: envPassword });
        loginStatus = fallbackLogin.status;
        loginData = fallbackLogin.data;
      }
    }

    if (!hadAuth && !process.env['API_TEST_EMAIL']) {
      expect([200, 401]).toContain(loginStatus);
      if (loginStatus === 200) {
        csrfToken = loginData['csrfToken'] as string;
      }
      authChecked = false;
      return;
    }

    expect(loginStatus).toBe(200);
    expect(loginData['csrfToken']).toBeDefined();
    csrfToken = loginData['csrfToken'] as string;
    authChecked = false;
  });
});

// ─── RBAC API ───────────────────────────────────────────────

describe('RBAC API', () => {
  let authenticated = false;
  let currentPermissions: string[] = [];

  beforeAll(async () => {
    const me = await api('GET', '/api/auth/me');
    if (me.status === 200) {
      authenticated = true;
      return;
    }

    const email = process.env['API_TEST_EMAIL'];
    const password = process.env['API_TEST_PASSWORD'];
    if (!email || !password) {
      authenticated = false;
      return;
    }

    const login = await api('POST', '/api/auth/login', { email, password });
    if (login.status === 200) {
      csrfToken = login.data['csrfToken'] as string;
      authenticated = true;
    }
  });

  it('returns effective persona permissions for authenticated user', async () => {
    const { status, data } = await api('GET', '/api/auth/permissions');
    if (!authenticated) {
      expect(status).toBe(401);
      return;
    }

    expect(status).toBe(200);
    expect(data['persona']).toBeDefined();
    expect(data['effectivePersona']).toBeDefined();

    currentPermissions = (data['permissions'] as string[]) ?? [];
    expect(Array.isArray(currentPermissions)).toBe(true);
    expect(currentPermissions.length).toBeGreaterThan(0);
  });

  it('denies tenant user access to platform RBAC admin route', async () => {
    const { status } = await api('GET', '/api/admin/rbac/users');
    if (!authenticated) {
      expect(status).toBe(401);
      return;
    }

    const isPlatformAdmin = currentPermissions.includes('admin:platform:write');
    if (isPlatformAdmin) {
      expect(status).toBe(200);
    } else {
      expect(status).toBe(403);
    }
  });

  it('requires auth for permissions endpoint', async () => {
    const previousCookie = cookie;
    const previousCsrf = csrfToken;
    cookie = '';
    csrfToken = '';
    const { status } = await api('GET', '/api/auth/permissions');
    expect(status).toBe(401);
    cookie = previousCookie;
    csrfToken = previousCsrf;
  });
});

// ─── Admin: Guardrails CRUD ──────────────────────────────────

describeAdmin('Admin Guardrails', () => {
  let guardrailId: string;

  it('lists guardrails', async () => {
    const { status, data } = await api('GET', '/api/admin/guardrails');
    expect(status).toBe(200);
    expect(Array.isArray(data['guardrails'])).toBe(true);
  });

  it('creates a guardrail', async () => {
    const { status, data } = await api('POST', '/api/admin/guardrails', {
      name: 'Test Regex Guard',
      description: 'Blocks SSNs',
      type: 'content_filter',
      stage: 'pre-execution',
      config: { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'deny' },
      priority: 10,
      enabled: true,
    });
    expect(status).toBe(201);
    const guardrail = data['guardrail'] as Record<string, unknown>;
    expect(guardrail?.['id']).toBeDefined();
    guardrailId = guardrail['id'] as string;
  });

  it('gets a guardrail by id', async () => {
    const { status, data } = await api('GET', `/api/admin/guardrails/${guardrailId}`);
    expect(status).toBe(200);
    expect((data['guardrail'] as Record<string, unknown>)?.['name']).toBe('Test Regex Guard');
  });

  it('updates a guardrail', async () => {
    const { status } = await api('PUT', `/api/admin/guardrails/${guardrailId}`, {
      name: 'Updated Regex Guard',
      priority: 5,
    });
    expect(status).toBe(200);
  });

  it('verifies update', async () => {
    const { data } = await api('GET', `/api/admin/guardrails/${guardrailId}`);
    expect((data['guardrail'] as Record<string, unknown>)?.['name']).toBe('Updated Regex Guard');
  });

  it('deletes a guardrail', async () => {
    const { status } = await api('DELETE', `/api/admin/guardrails/${guardrailId}`);
    expect(status).toBe(200);
  });
});

// ─── Admin: Workflows CRUD ───────────────────────────────────

describeAdmin('Admin Workflows', () => {
  let workflowId: string;

  it('lists workflows', async () => {
    const { status, data } = await api('GET', '/api/admin/workflows');
    expect(status).toBe(200);
    expect(Array.isArray(data['workflows'])).toBe(true);
  });

  it('creates a workflow', async () => {
    const { status, data } = await api('POST', '/api/admin/workflows', {
      name: 'Test Pipeline',
      description: 'Integration test workflow',
      steps: [{ id: 's1', name: 'Validate', type: 'deterministic' }],
      entry_step_id: 's1',
      version: '1.0.0',
      enabled: true,
    });
    expect(status).toBe(201);
    const workflow = data['workflow'] as Record<string, unknown>;
    expect(workflow?.['id']).toBeDefined();
    workflowId = workflow['id'] as string;
  });

  it('gets a workflow by id', async () => {
    const { status, data } = await api('GET', `/api/admin/workflows/${workflowId}`);
    expect(status).toBe(200);
    expect((data['workflow'] as Record<string, unknown>)?.['name']).toBe('Test Pipeline');
  });

  it('updates a workflow', async () => {
    const { status } = await api('PUT', `/api/admin/workflows/${workflowId}`, {
      name: 'Renamed Pipeline',
    });
    expect(status).toBe(200);
  });

  it('deletes a workflow', async () => {
    const { status } = await api('DELETE', `/api/admin/workflows/${workflowId}`);
    expect(status).toBe(200);
  });
});

// ─── Workflow Runs ───────────────────────────────────────────

describe('Workflow Runs', () => {
  let runId: string;

  it('lists workflow runs', async () => {
    const hasAuth = await ensureAuthenticated();
    const { status, data } = await api('GET', '/api/workflow-runs');
    if (!hasAuth) { expect(status).toBe(401); return; }
    expect(status).toBe(200);
    expect(Array.isArray(data['runs'])).toBe(true);
  });

  it('creates a workflow run', async () => {
    const hasAuth = await ensureAuthenticated();
    const { status, data } = await api('POST', '/api/workflow-runs', {
      workflow_id: 'test-wf',
      input: { msg: 'hello' },
    });
    if (!hasAuth) { expect(status).toBe(401); return; }
    expect(status).toBe(201);
    expect(data['id']).toBeDefined();
    runId = data['id'] as string;
  });

  it('gets a workflow run by id', async () => {
    const hasAuth = await ensureAuthenticated();
    const { status, data } = await api('GET', `/api/workflow-runs/${runId}`);
    if (!hasAuth) { expect(status).toBe(401); return; }
    expect(status).toBe(200);
    expect((data['run'] as Record<string, unknown>)?.['id']).toBe(runId);
  });

  it('updates a workflow run status', async () => {
    const hasAuth = await ensureAuthenticated();
    const { status } = await api('PUT', `/api/workflow-runs/${runId}`, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    if (!hasAuth) { expect(status).toBe(401); return; }
    expect(status).toBe(200);
  });
});

// ─── Guardrail Evaluations ──────────────────────────────────

describe('Guardrail Evaluations', () => {
  it('lists guardrail evaluations', async () => {
    const hasAuth = await ensureAuthenticated();
    const { status, data } = await api('GET', '/api/guardrail-evals');
    if (!hasAuth) { expect(status).toBe(401); return; }
    expect(status).toBe(200);
    expect(Array.isArray(data['evals'])).toBe(true);
  });

  it('supports limit parameter', async () => {
    const hasAuth = await ensureAuthenticated();
    const { status, data } = await api('GET', '/api/guardrail-evals?limit=5');
    if (!hasAuth) { expect(status).toBe(401); return; }
    expect(status).toBe(200);
    expect(Array.isArray(data['evals'])).toBe(true);
  });
});

// ─── Admin: Prompts CRUD ────────────────────────────────────

describeAdmin('Admin Prompts', () => {
  let promptId: string;
  let defaultAId: string;
  let defaultBId: string;

  it('lists prompts', async () => {
    const { status, data } = await api('GET', '/api/admin/prompts');
    expect(status).toBe(200);
    expect(Array.isArray(data['prompts'])).toBe(true);
  });

  it('creates a prompt', async () => {
    const { status, data } = await api('POST', '/api/admin/prompts', {
      name: 'Test Prompt',
      description: 'Integration test prompt',
      category: 'test',
      template: 'Hello {{name}}, you are a {{role}}.',
      variables: JSON.stringify([
        { name: 'name', type: 'string', required: true },
        { name: 'role', type: 'string', required: true },
      ]),
      version: '1.0',
      is_default: false,
      enabled: true,
    });
    expect(status).toBe(201);
    const prompt = data['prompt'] as Record<string, unknown>;
    expect(prompt?.['id']).toBeDefined();
    expect(prompt?.['name']).toBe('Test Prompt');
    promptId = prompt['id'] as string;
  });

  it('gets a prompt by id', async () => {
    const { status, data } = await api('GET', `/api/admin/prompts/${promptId}`);
    expect(status).toBe(200);
    const prompt = data['prompt'] as Record<string, unknown>;
    expect(prompt?.['name']).toBe('Test Prompt');
    expect(prompt?.['template']).toContain('{{name}}');
    const parsedVars = JSON.parse(String(prompt?.['variables'] ?? '[]')) as unknown[];
    expect(parsedVars).toEqual(['name', 'role']);
  });

  it('normalizes variables sent as array of names', async () => {
    const { status } = await api('PUT', `/api/admin/prompts/${promptId}`, {
      variables: ['first_name', 'role', 'role'],
    });
    expect(status).toBe(200);

    const { data } = await api('GET', `/api/admin/prompts/${promptId}`);
    const prompt = data['prompt'] as Record<string, unknown>;
    const parsedVars = JSON.parse(String(prompt?.['variables'] ?? '[]')) as unknown[];
    expect(parsedVars).toEqual(['first_name', 'role']);
  });

  it('enforces a single default prompt', async () => {
    const createdA = await api('POST', '/api/admin/prompts', {
      name: 'Default A',
      description: 'First default candidate',
      category: 'test',
      template: 'A',
      is_default: true,
      enabled: true,
    });
    expect(createdA.status).toBe(201);
    defaultAId = ((createdA.data['prompt'] as Record<string, unknown>)?.['id'] as string);

    const createdB = await api('POST', '/api/admin/prompts', {
      name: 'Default B',
      description: 'Second default candidate',
      category: 'test',
      template: 'B',
      is_default: true,
      enabled: true,
    });
    expect(createdB.status).toBe(201);
    defaultBId = ((createdB.data['prompt'] as Record<string, unknown>)?.['id'] as string);

    const { status, data } = await api('GET', '/api/admin/prompts');
    expect(status).toBe(200);
    const prompts = (data['prompts'] as Array<Record<string, unknown>>) ?? [];
    const defaults = prompts.filter((p) => Number(p['is_default']) === 1);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.['id']).toBe(defaultBId);
  });

  it('updates a prompt', async () => {
    const { status } = await api('PUT', `/api/admin/prompts/${promptId}`, {
      name: 'Updated Prompt',
      template: 'Goodbye {{name}}!',
    });
    expect(status).toBe(200);
  });

  it('verifies update', async () => {
    const { data } = await api('GET', `/api/admin/prompts/${promptId}`);
    const prompt = data['prompt'] as Record<string, unknown>;
    expect(prompt?.['name']).toBe('Updated Prompt');
    expect(prompt?.['template']).toContain('Goodbye');
  });

  it('deletes a prompt', async () => {
    const { status } = await api('DELETE', `/api/admin/prompts/${promptId}`);
    expect(status).toBe(200);
  });

  afterAll(async () => {
    if (defaultAId) await api('DELETE', `/api/admin/prompts/${defaultAId}`);
    if (defaultBId) await api('DELETE', `/api/admin/prompts/${defaultBId}`);
  });
});

// ─── Prompt Resolution ──────────────────────────────────────

describeAdmin('Prompt Resolution', () => {
  let resolvePromptId: string;

  beforeAll(async () => {
    // Create a prompt to resolve
    const { data } = await api('POST', '/api/admin/prompts', {
      name: 'Resolve Test',
      description: 'For resolve testing',
      category: 'test',
      template: 'Hello {{user}}, welcome to {{app}}.',
      variables: JSON.stringify([
        { name: 'user', type: 'string', required: true },
        { name: 'app', type: 'string', required: true },
      ]),
      version: '1.0',
      is_default: false,
      enabled: true,
    });
    resolvePromptId = ((data['prompt'] as Record<string, unknown>)?.['id'] as string);
  });

  it('resolves a prompt with variables', async () => {
    const { status, data } = await api('POST', '/api/prompts/resolve', {
      promptId: resolvePromptId,
      variables: { user: 'Alice', app: 'WeaveIntel' },
    });
    expect(status).toBe(200);
    expect(data['rendered']).toBe('Hello Alice, welcome to WeaveIntel.');
    expect(data['template']).toContain('{{user}}');
    expect(data['variables']).toBeDefined();
  });

  it('returns 400 for missing required variable', async () => {
    const { status, data } = await api('POST', '/api/prompts/resolve', {
      promptId: resolvePromptId,
      variables: { user: 'Alice' },
    });
    expect(status).toBe(400);
    expect(data['error']).toContain('Missing required variable');
  });

  it('returns 404 for unknown prompt', async () => {
    const { status } = await api('POST', '/api/prompts/resolve', {
      promptId: 'nonexistent-id',
    });
    expect(status).toBe(404);
  });

  it('returns 400 when promptId missing', async () => {
    const { status } = await api('POST', '/api/prompts/resolve', {});
    expect(status).toBe(400);
  });

  afterAll(async () => {
    if (resolvePromptId) await api('DELETE', `/api/admin/prompts/${resolvePromptId}`);
  });
});

// ─── Admin: Routing CRUD ────────────────────────────────────

describeAdmin('Admin Routing', () => {
  let policyId: string;

  it('lists routing policies', async () => {
    const { status, data } = await api('GET', '/api/admin/routing');
    expect(status).toBe(200);
    expect(Array.isArray(data['policies'])).toBe(true);
  });

  it('creates a routing policy', async () => {
    const { status, data } = await api('POST', '/api/admin/routing', {
      name: 'Test Routing Policy',
      description: 'Integration test policy',
      strategy: 'cost-optimized',
      constraints: JSON.stringify({ excludeProviders: [] }),
      weights: JSON.stringify({ cost: 0.7, latency: 0.2, quality: 0.1 }),
      fallback_model: 'gpt-4o-mini',
      fallback_provider: 'openai',
      enabled: true,
    });
    expect(status).toBe(201);
    const policy = data['policy'] as Record<string, unknown>;
    expect(policy?.['id']).toBeDefined();
    expect(policy?.['name']).toBe('Test Routing Policy');
    policyId = policy['id'] as string;
  });

  it('gets a routing policy by id', async () => {
    const { status, data } = await api('GET', `/api/admin/routing/${policyId}`);
    expect(status).toBe(200);
    const policy = data['policy'] as Record<string, unknown>;
    expect(policy?.['name']).toBe('Test Routing Policy');
    expect(policy?.['strategy']).toBe('cost-optimized');
  });

  it('updates a routing policy', async () => {
    const { status } = await api('PUT', `/api/admin/routing/${policyId}`, {
      name: 'Updated Routing Policy',
      strategy: 'quality-first',
    });
    expect(status).toBe(200);
  });

  it('verifies update', async () => {
    const { data } = await api('GET', `/api/admin/routing/${policyId}`);
    const policy = data['policy'] as Record<string, unknown>;
    expect(policy?.['name']).toBe('Updated Routing Policy');
    expect(policy?.['strategy']).toBe('quality-first');
  });

  it('deletes a routing policy', async () => {
    const { status } = await api('DELETE', `/api/admin/routing/${policyId}`);
    expect(status).toBe(200);
  });
});

// ─── Routing Active Policies ────────────────────────────────

describeAdmin('Routing Active', () => {
  it('lists active routing policies', async () => {
    const { status, data } = await api('GET', '/api/routing/active');
    expect(status).toBe(200);
    expect(Array.isArray(data['active'])).toBe(true);
    // All returned should be enabled (SQLite stores as 1)
    for (const p of data['active'] as Array<Record<string, unknown>>) {
      expect(p['enabled']).toBeTruthy();
    }
  });
});

// ─── Admin: Tools CRUD ──────────────────────────────────────

describeAdmin('Admin Tools', () => {
  it('lists tools', async () => {
    const { status, data } = await api('GET', '/api/admin/tools');
    expect(status).toBe(200);
    expect(Array.isArray(data['tools'])).toBe(true);
  });
});

// ─── Models ─────────────────────────────────────────────────

describe('Models', () => {
  it('lists available models', async () => {
    const hasAuth = await ensureAuthenticated();
    const { status, data } = await api('GET', '/api/models');
    if (!hasAuth) { expect(status).toBe(401); return; }
    expect(status).toBe(200);
    expect(Array.isArray(data['models'])).toBe(true);
  });
});

// ─── Admin: Task Policies CRUD ──────────────────────────────

describeAdmin('Admin Task Policies', () => {
  let policyId: string;

  it('lists task policies', async () => {
    const { status, data } = await api('GET', '/api/admin/task-policies');
    expect(status).toBe(200);
    expect(Array.isArray(data['taskPolicies'])).toBe(true);
  });

  it('creates a task policy', async () => {
    const { status, data } = await api('POST', '/api/admin/task-policies', {
      name: 'Test Approval Policy',
      description: 'Requires approval for dangerous ops',
      trigger: 'delete_resource',
      task_type: 'approval',
      default_priority: 'high',
      sla_hours: 4,
      auto_escalate_after_hours: 8,
      assignment_strategy: 'round-robin',
      assign_to: 'admin-team',
      enabled: true,
    });
    expect(status).toBe(201);
    const policy = data['taskPolicy'] as Record<string, unknown>;
    expect(policy?.['id']).toBeDefined();
    expect(policy?.['name']).toBe('Test Approval Policy');
    policyId = policy['id'] as string;
  });

  it('gets a task policy by id', async () => {
    const { status, data } = await api('GET', `/api/admin/task-policies/${policyId}`);
    expect(status).toBe(200);
    const policy = data['taskPolicy'] as Record<string, unknown>;
    expect(policy?.['name']).toBe('Test Approval Policy');
    expect(policy?.['trigger']).toBe('delete_resource');
  });

  it('updates a task policy', async () => {
    const { status, data } = await api('PUT', `/api/admin/task-policies/${policyId}`, {
      name: 'Updated Approval Policy',
      sla_hours: 2,
    });
    expect(status).toBe(200);
    const policy = data['taskPolicy'] as Record<string, unknown>;
    expect(policy?.['name']).toBe('Updated Approval Policy');
  });

  it('verifies update', async () => {
    const { data } = await api('GET', `/api/admin/task-policies/${policyId}`);
    const policy = data['taskPolicy'] as Record<string, unknown>;
    expect(policy?.['name']).toBe('Updated Approval Policy');
    expect(policy?.['sla_hours']).toBe(2);
  });

  it('deletes a task policy', async () => {
    const { status, data } = await api('DELETE', `/api/admin/task-policies/${policyId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Contracts CRUD ──────────────────────────────────

describeAdmin('Admin Contracts', () => {
  let contractId: string;

  it('lists contracts', async () => {
    const { status, data } = await api('GET', '/api/admin/contracts');
    expect(status).toBe(200);
    expect(Array.isArray(data['contracts'])).toBe(true);
  });

  it('creates a contract', async () => {
    const { status, data } = await api('POST', '/api/admin/contracts', {
      name: 'Test Contract',
      description: 'Integration test contract',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      output_schema: { type: 'object', properties: { answer: { type: 'string' } } },
      acceptance_criteria: [
        { id: 'ac1', description: 'Must have answer', type: 'schema', config: {} },
      ],
      max_attempts: 3,
      timeout_ms: 30000,
      evidence_required: ['text'],
      min_confidence: 0.8,
      require_human_review: false,
      enabled: true,
    });
    expect(status).toBe(201);
    const contract = data['contract'] as Record<string, unknown>;
    expect(contract?.['id']).toBeDefined();
    expect(contract?.['name']).toBe('Test Contract');
    contractId = contract['id'] as string;
  });

  it('gets a contract by id', async () => {
    const { status, data } = await api('GET', `/api/admin/contracts/${contractId}`);
    expect(status).toBe(200);
    const contract = data['contract'] as Record<string, unknown>;
    expect(contract?.['name']).toBe('Test Contract');
  });

  it('updates a contract', async () => {
    const { status, data } = await api('PUT', `/api/admin/contracts/${contractId}`, {
      name: 'Updated Contract',
      max_attempts: 5,
    });
    expect(status).toBe(200);
    const contract = data['contract'] as Record<string, unknown>;
    expect(contract?.['name']).toBe('Updated Contract');
  });

  it('verifies update', async () => {
    const { data } = await api('GET', `/api/admin/contracts/${contractId}`);
    const contract = data['contract'] as Record<string, unknown>;
    expect(contract?.['name']).toBe('Updated Contract');
    expect(contract?.['max_attempts']).toBe(5);
  });

  it('deletes a contract', async () => {
    const { status, data } = await api('DELETE', `/api/admin/contracts/${contractId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Cache Policies CRUD ─────────────────────────────

describeAdmin('Admin Cache Policies', () => {
  let policyId: string;

  it('lists cache policies', async () => {
    const { status, data } = await api('GET', '/api/admin/cache-policies');
    expect(status).toBe(200);
    expect(Array.isArray(data['cache-policies'])).toBe(true);
  });

  it('creates a cache policy', async () => {
    const { status, data } = await api('POST', '/api/admin/cache-policies', {
      name: 'Test Cache Policy',
      description: 'Integration test cache policy',
      scope: 'session',
      ttl_ms: 60000,
      max_entries: 500,
      bypass_patterns: ['password', 'secret'],
      invalidate_on: ['model-change'],
      enabled: true,
    });
    expect(status).toBe(201);
    const policy = data['cache-policy'] as Record<string, unknown>;
    expect(policy?.['id']).toBeDefined();
    expect(policy?.['name']).toBe('Test Cache Policy');
    expect(policy?.['scope']).toBe('session');
    policyId = policy['id'] as string;
  });

  it('gets a cache policy by id', async () => {
    const { status, data } = await api('GET', `/api/admin/cache-policies/${policyId}`);
    expect(status).toBe(200);
    const policy = data['cache-policy'] as Record<string, unknown>;
    expect(policy?.['name']).toBe('Test Cache Policy');
  });

  it('updates a cache policy', async () => {
    const { status, data } = await api('PUT', `/api/admin/cache-policies/${policyId}`, {
      name: 'Updated Cache Policy',
      ttl_ms: 120000,
    });
    expect(status).toBe(200);
    const policy = data['cache-policy'] as Record<string, unknown>;
    expect(policy?.['name']).toBe('Updated Cache Policy');
  });

  it('verifies update', async () => {
    const { data } = await api('GET', `/api/admin/cache-policies/${policyId}`);
    const policy = data['cache-policy'] as Record<string, unknown>;
    expect(policy?.['name']).toBe('Updated Cache Policy');
    expect(policy?.['ttl_ms']).toBe(120000);
  });

  it('deletes a cache policy', async () => {
    const { status, data } = await api('DELETE', `/api/admin/cache-policies/${policyId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Identity Rules CRUD ─────────────────────────────

describeAdmin('Admin Identity Rules', () => {
  let ruleId: string;

  it('lists identity rules', async () => {
    const { status, data } = await api('GET', '/api/admin/identity-rules');
    expect(status).toBe(200);
    expect(Array.isArray(data['identity-rules'])).toBe(true);
  });

  it('creates an identity rule', async () => {
    const { status, data } = await api('POST', '/api/admin/identity-rules', {
      name: 'Test Identity Rule',
      description: 'Integration test identity rule',
      resource: 'test:*',
      action: 'read',
      roles: ['tester'],
      scopes: ['test'],
      result: 'allow',
      priority: 50,
      enabled: true,
    });
    expect(status).toBe(201);
    const rule = data['identity-rule'] as Record<string, unknown>;
    expect(rule?.['id']).toBeDefined();
    expect(rule?.['name']).toBe('Test Identity Rule');
    expect(rule?.['resource']).toBe('test:*');
    ruleId = rule['id'] as string;
  });

  it('gets an identity rule by id', async () => {
    const { status, data } = await api('GET', `/api/admin/identity-rules/${ruleId}`);
    expect(status).toBe(200);
    const rule = data['identity-rule'] as Record<string, unknown>;
    expect(rule?.['name']).toBe('Test Identity Rule');
  });

  it('updates an identity rule', async () => {
    const { status, data } = await api('PUT', `/api/admin/identity-rules/${ruleId}`, {
      name: 'Updated Identity Rule',
      priority: 25,
    });
    expect(status).toBe(200);
    const rule = data['identity-rule'] as Record<string, unknown>;
    expect(rule?.['name']).toBe('Updated Identity Rule');
  });

  it('verifies update', async () => {
    const { data } = await api('GET', `/api/admin/identity-rules/${ruleId}`);
    const rule = data['identity-rule'] as Record<string, unknown>;
    expect(rule?.['name']).toBe('Updated Identity Rule');
    expect(rule?.['priority']).toBe(25);
  });

  it('deletes an identity rule', async () => {
    const { status, data } = await api('DELETE', `/api/admin/identity-rules/${ruleId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Memory Governance CRUD ──────────────────────────

describeAdmin('Admin Memory Governance', () => {
  let ruleId: string;

  it('lists memory governance rules', async () => {
    const { status, data } = await api('GET', '/api/admin/memory-governance');
    expect(status).toBe(200);
    expect(Array.isArray(data['memory-governance'])).toBe(true);
  });

  it('creates a memory governance rule', async () => {
    const { status, data } = await api('POST', '/api/admin/memory-governance', {
      name: 'Test Memory Governance',
      description: 'Integration test memory governance',
      memory_types: ['conversation', 'entity'],
      tenant_id: 'test-tenant',
      block_patterns: ['password', 'ssn'],
      redact_patterns: ['\\b\\d{3}-\\d{2}-\\d{4}\\b'],
      max_age: 'P30D',
      max_entries: 1000,
      enabled: true,
    });
    expect(status).toBe(201);
    const rule = data['memory-governance-rule'] as Record<string, unknown>;
    expect(rule?.['id']).toBeDefined();
    expect(rule?.['name']).toBe('Test Memory Governance');
    ruleId = rule['id'] as string;
  });

  it('gets a memory governance rule by id', async () => {
    const { status, data } = await api('GET', `/api/admin/memory-governance/${ruleId}`);
    expect(status).toBe(200);
    const rule = data['memory-governance-rule'] as Record<string, unknown>;
    expect(rule?.['name']).toBe('Test Memory Governance');
  });

  it('updates a memory governance rule', async () => {
    const { status, data } = await api('PUT', `/api/admin/memory-governance/${ruleId}`, {
      name: 'Updated Memory Governance',
      max_entries: 2000,
    });
    expect(status).toBe(200);
    const rule = data['memory-governance-rule'] as Record<string, unknown>;
    expect(rule?.['name']).toBe('Updated Memory Governance');
  });

  it('verifies update', async () => {
    const { data } = await api('GET', `/api/admin/memory-governance/${ruleId}`);
    const rule = data['memory-governance-rule'] as Record<string, unknown>;
    expect(rule?.['name']).toBe('Updated Memory Governance');
    expect(rule?.['max_entries']).toBe(2000);
  });

  it('deletes a memory governance rule', async () => {
    const { status, data } = await api('DELETE', `/api/admin/memory-governance/${ruleId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Seed ───────────────────────────────────────────────────

describeAdmin('Seed', () => {
  it('seeds default data', async () => {
    const { status, data } = await api('POST', '/api/admin/seed');
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Search Providers CRUD ────────────────────────────

describeAdmin('Admin Search Providers', () => {
  let itemId: string;

  it('lists search providers', async () => {
    const { status, data } = await api('GET', '/api/admin/search-providers');
    expect(status).toBe(200);
    expect(Array.isArray(data['search-providers'])).toBe(true);
  });

  it('creates a search provider', async () => {
    const { status, data } = await api('POST', '/api/admin/search-providers', {
      name: 'Test Provider',
      description: 'Integration test provider',
      provider_type: 'brave',
      api_key: 'test-key-123',
      base_url: 'https://api.search.brave.com',
      priority: 5,
      options: { safesearch: true },
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['search-provider'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a search provider by id', async () => {
    const { status, data } = await api('GET', `/api/admin/search-providers/${itemId}`);
    expect(status).toBe(200);
    expect((data['search-provider'] as Record<string, unknown>)?.['name']).toBe('Test Provider');
  });

  it('updates a search provider', async () => {
    const { status, data } = await api('PUT', `/api/admin/search-providers/${itemId}`, {
      name: 'Updated Provider',
      priority: 10,
    });
    expect(status).toBe(200);
    expect((data['search-provider'] as Record<string, unknown>)?.['name']).toBe('Updated Provider');
  });

  it('deletes a search provider', async () => {
    const { status, data } = await api('DELETE', `/api/admin/search-providers/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: HTTP Endpoints CRUD ──────────────────────────────

describeAdmin('Admin HTTP Endpoints', () => {
  let itemId: string;

  it('lists http endpoints', async () => {
    const { status, data } = await api('GET', '/api/admin/http-endpoints');
    expect(status).toBe(200);
    expect(Array.isArray(data['http-endpoints'])).toBe(true);
  });

  it('creates an http endpoint', async () => {
    const { status, data } = await api('POST', '/api/admin/http-endpoints', {
      name: 'Test Endpoint',
      description: 'Integration test endpoint',
      url: 'https://httpbin.org/get',
      method: 'GET',
      auth_type: 'none',
      auth_config: null,
      headers: { 'Accept': 'application/json' },
      retry_count: 2,
      rate_limit_rpm: 30,
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['http-endpoint'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets an http endpoint by id', async () => {
    const { status, data } = await api('GET', `/api/admin/http-endpoints/${itemId}`);
    expect(status).toBe(200);
    expect((data['http-endpoint'] as Record<string, unknown>)?.['name']).toBe('Test Endpoint');
  });

  it('updates an http endpoint', async () => {
    const { status, data } = await api('PUT', `/api/admin/http-endpoints/${itemId}`, {
      name: 'Updated Endpoint',
      method: 'POST',
    });
    expect(status).toBe(200);
    expect((data['http-endpoint'] as Record<string, unknown>)?.['name']).toBe('Updated Endpoint');
  });

  it('deletes an http endpoint', async () => {
    const { status, data } = await api('DELETE', `/api/admin/http-endpoints/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Social Accounts CRUD ─────────────────────────────

describeAdmin('Admin Social Accounts', () => {
  let itemId: string;

  it('lists social accounts', async () => {
    const { status, data } = await api('GET', '/api/admin/social-accounts');
    expect(status).toBe(200);
    expect(Array.isArray(data['social-accounts'])).toBe(true);
  });

  it('creates a social account', async () => {
    const { status, data } = await api('POST', '/api/admin/social-accounts', {
      name: 'Test Slack',
      description: 'Integration test slack account',
      platform: 'slack',
      api_key: 'xoxb-test-key',
      api_secret: '',
      base_url: 'https://slack.com/api',
      options: { default_channel: '#general' },
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['social-account'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a social account by id', async () => {
    const { status, data } = await api('GET', `/api/admin/social-accounts/${itemId}`);
    expect(status).toBe(200);
    expect((data['social-account'] as Record<string, unknown>)?.['name']).toBe('Test Slack');
  });

  it('updates a social account', async () => {
    const { status, data } = await api('PUT', `/api/admin/social-accounts/${itemId}`, {
      name: 'Updated Slack',
      platform: 'discord',
    });
    expect(status).toBe(200);
    expect((data['social-account'] as Record<string, unknown>)?.['name']).toBe('Updated Slack');
  });

  it('deletes a social account', async () => {
    const { status, data } = await api('DELETE', `/api/admin/social-accounts/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Enterprise Connectors CRUD ───────────────────────

describeAdmin('Admin Enterprise Connectors', () => {
  let itemId: string;

  it('lists enterprise connectors', async () => {
    const { status, data } = await api('GET', '/api/admin/enterprise-connectors');
    expect(status).toBe(200);
    expect(Array.isArray(data['enterprise-connectors'])).toBe(true);
  });

  it('creates an enterprise connector', async () => {
    const { status, data } = await api('POST', '/api/admin/enterprise-connectors', {
      name: 'Test Jira',
      description: 'Integration test Jira connector',
      connector_type: 'jira',
      base_url: 'https://test.atlassian.net',
      auth_type: 'bearer',
      auth_config: { token: 'test-token-123' },
      options: { project: 'TEST' },
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['enterprise-connector'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets an enterprise connector by id', async () => {
    const { status, data } = await api('GET', `/api/admin/enterprise-connectors/${itemId}`);
    expect(status).toBe(200);
    expect((data['enterprise-connector'] as Record<string, unknown>)?.['name']).toBe('Test Jira');
  });

  it('updates an enterprise connector', async () => {
    const { status, data } = await api('PUT', `/api/admin/enterprise-connectors/${itemId}`, {
      name: 'Updated Jira',
      connector_type: 'confluence',
    });
    expect(status).toBe(200);
    expect((data['enterprise-connector'] as Record<string, unknown>)?.['name']).toBe('Updated Jira');
  });

  it('deletes an enterprise connector', async () => {
    const { status, data } = await api('DELETE', `/api/admin/enterprise-connectors/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Tool Registry CRUD ───────────────────────────────

describeAdmin('Admin Tool Registry', () => {
  let itemId: string;

  it('lists tool registry entries', async () => {
    const { status, data } = await api('GET', '/api/admin/tool-registry');
    expect(status).toBe(200);
    expect(Array.isArray(data['tool-registry'])).toBe(true);
  });

  it('creates a tool registry entry', async () => {
    const { status, data } = await api('POST', '/api/admin/tool-registry', {
      name: 'Test Tool',
      description: 'Integration test tool',
      package_name: '@weaveintel/tools-test',
      version: '0.1.0',
      category: 'custom',
      risk_level: 'low',
      tags: ['test', 'integration'],
      config: { timeout: 5000 },
      requires_approval: false,
      max_execution_ms: 10000,
      rate_limit_per_min: 100,
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['tool-registry-entry'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a tool registry entry by id', async () => {
    const { status, data } = await api('GET', `/api/admin/tool-registry/${itemId}`);
    expect(status).toBe(200);
    expect((data['tool-registry-entry'] as Record<string, unknown>)?.['name']).toBe('Test Tool');
  });

  it('updates a tool registry entry', async () => {
    const { status, data } = await api('PUT', `/api/admin/tool-registry/${itemId}`, {
      name: 'Updated Tool',
      risk_level: 'medium',
    });
    expect(status).toBe(200);
    expect((data['tool-registry-entry'] as Record<string, unknown>)?.['name']).toBe('Updated Tool');
  });

  it('deletes a tool registry entry', async () => {
    const { status, data } = await api('DELETE', `/api/admin/tool-registry/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Replay Scenarios CRUD ────────────────────────────

describeAdmin('Admin Replay Scenarios', () => {
  let itemId: string;

  it('lists replay scenarios', async () => {
    const { status, data } = await api('GET', '/api/admin/replay-scenarios');
    expect(status).toBe(200);
    expect(Array.isArray(data['replay-scenarios'])).toBe(true);
  });

  it('creates a replay scenario', async () => {
    const { status, data } = await api('POST', '/api/admin/replay-scenarios', {
      name: 'Test Replay',
      description: 'Integration test scenario',
      golden_prompt: 'What is 2+2?',
      golden_response: 'The answer is 4.',
      model: 'gpt-4o-mini',
      provider: 'openai',
      tags: ['test', 'math'],
      acceptance_criteria: { min_match_rate: 0.7 },
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['replay-scenario'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a replay scenario by id', async () => {
    const { status, data } = await api('GET', `/api/admin/replay-scenarios/${itemId}`);
    expect(status).toBe(200);
    expect((data['replay-scenario'] as Record<string, unknown>)?.['name']).toBe('Test Replay');
  });

  it('updates a replay scenario', async () => {
    const { status, data } = await api('PUT', `/api/admin/replay-scenarios/${itemId}`, {
      name: 'Updated Replay',
      golden_prompt: 'What is 3+3?',
    });
    expect(status).toBe(200);
    expect((data['replay-scenario'] as Record<string, unknown>)?.['name']).toBe('Updated Replay');
  });

  it('deletes a replay scenario', async () => {
    const { status, data } = await api('DELETE', `/api/admin/replay-scenarios/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Trigger Definitions CRUD ─────────────────────────

describeAdmin('Admin Trigger Definitions', () => {
  let itemId: string;

  it('lists trigger definitions', async () => {
    const { status, data } = await api('GET', '/api/admin/trigger-definitions');
    expect(status).toBe(200);
    expect(Array.isArray(data['trigger-definitions'])).toBe(true);
  });

  it('creates a trigger definition', async () => {
    const { status, data } = await api('POST', '/api/admin/trigger-definitions', {
      name: 'Test Trigger',
      description: 'Integration test trigger',
      trigger_type: 'cron',
      expression: '0 0 * * *',
      config: { timezone: 'UTC' },
      target_workflow: 'wf-test',
      status: 'active',
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['trigger-definition'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a trigger definition by id', async () => {
    const { status, data } = await api('GET', `/api/admin/trigger-definitions/${itemId}`);
    expect(status).toBe(200);
    expect((data['trigger-definition'] as Record<string, unknown>)?.['name']).toBe('Test Trigger');
  });

  it('updates a trigger definition', async () => {
    const { status, data } = await api('PUT', `/api/admin/trigger-definitions/${itemId}`, {
      name: 'Updated Trigger',
      status: 'paused',
    });
    expect(status).toBe(200);
    expect((data['trigger-definition'] as Record<string, unknown>)?.['name']).toBe('Updated Trigger');
  });

  it('deletes a trigger definition', async () => {
    const { status, data } = await api('DELETE', `/api/admin/trigger-definitions/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin: Tenant Configs CRUD ──────────────────────────────

describeAdmin('Admin Tenant Configs', () => {
  let itemId: string;

  it('lists tenant configs', async () => {
    const { status, data } = await api('GET', '/api/admin/tenant-configs');
    expect(status).toBe(200);
    expect(Array.isArray(data['tenant-configs'])).toBe(true);
  });

  it('creates a tenant config', async () => {
    const { status, data } = await api('POST', '/api/admin/tenant-configs', {
      name: 'Test Tenant',
      description: 'Integration test tenant',
      tenant_id: 'test-tenant',
      scope: 'tenant',
      allowed_models: ['gpt-4o-mini'],
      denied_models: [],
      allowed_tools: ['web-search'],
      max_tokens_daily: 50000,
      max_cost_daily: 2.5,
      max_tokens_monthly: 500000,
      max_cost_monthly: 25.0,
      features: ['chat', 'tools'],
      config_overrides: { max_concurrent_runs: 2 },
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['tenant-config'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a tenant config by id', async () => {
    const { status, data } = await api('GET', `/api/admin/tenant-configs/${itemId}`);
    expect(status).toBe(200);
    expect((data['tenant-config'] as Record<string, unknown>)?.['name']).toBe('Test Tenant');
  });

  it('updates a tenant config', async () => {
    const { status, data } = await api('PUT', `/api/admin/tenant-configs/${itemId}`, {
      name: 'Updated Tenant',
      max_tokens_daily: 100000,
    });
    expect(status).toBe(200);
    expect((data['tenant-config'] as Record<string, unknown>)?.['name']).toBe('Updated Tenant');
  });

  it('deletes a tenant config', async () => {
    const { status, data } = await api('DELETE', `/api/admin/tenant-configs/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Sandbox Policies ─────────────────────────────────

describeAdmin('Admin Sandbox Policies', () => {
  let itemId: string;

  it('lists sandbox policies', async () => {
    const { status, data } = await api('GET', '/api/admin/sandbox-policies');
    expect(status).toBe(200);
    expect(Array.isArray(data['sandbox-policies'])).toBe(true);
  });

  it('creates a sandbox policy', async () => {
    const { status, data } = await api('POST', '/api/admin/sandbox-policies', {
      name: 'Test Sandbox',
      description: 'Integration test sandbox policy',
      max_cpu_ms: 10000,
      max_memory_mb: 128,
      max_duration_ms: 30000,
      max_output_bytes: 65536,
      allowed_modules: ['Math', 'Date', 'JSON'],
      denied_modules: ['fs', 'net', 'child_process'],
      network_access: false,
      filesystem_access: 'none',
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['sandbox-policy'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a sandbox policy by id', async () => {
    const { status, data } = await api('GET', `/api/admin/sandbox-policies/${itemId}`);
    expect(status).toBe(200);
    expect((data['sandbox-policy'] as Record<string, unknown>)?.['name']).toBe('Test Sandbox');
  });

  it('updates a sandbox policy', async () => {
    const { status, data } = await api('PUT', `/api/admin/sandbox-policies/${itemId}`, {
      name: 'Updated Sandbox',
      max_duration_ms: 60000,
    });
    expect(status).toBe(200);
    expect((data['sandbox-policy'] as Record<string, unknown>)?.['name']).toBe('Updated Sandbox');
  });

  it('deletes a sandbox policy', async () => {
    const { status, data } = await api('DELETE', `/api/admin/sandbox-policies/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Extraction Pipelines ─────────────────────────────

describeAdmin('Admin Extraction Pipelines', () => {
  let itemId: string;

  it('lists extraction pipelines', async () => {
    const { status, data } = await api('GET', '/api/admin/extraction-pipelines');
    expect(status).toBe(200);
    expect(Array.isArray(data['extraction-pipelines'])).toBe(true);
  });

  it('creates an extraction pipeline', async () => {
    const { status, data } = await api('POST', '/api/admin/extraction-pipelines', {
      name: 'Test Pipeline',
      description: 'Integration test extraction pipeline',
      stages: [
        { type: 'metadata', enabled: true, order: 1 },
        { type: 'entities', enabled: true, order: 2 },
      ],
      input_mime_types: ['text/plain', 'text/markdown'],
      max_input_size_bytes: 5242880,
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['extraction-pipeline'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets an extraction pipeline by id', async () => {
    const { status, data } = await api('GET', `/api/admin/extraction-pipelines/${itemId}`);
    expect(status).toBe(200);
    expect((data['extraction-pipeline'] as Record<string, unknown>)?.['name']).toBe('Test Pipeline');
  });

  it('updates an extraction pipeline', async () => {
    const { status, data } = await api('PUT', `/api/admin/extraction-pipelines/${itemId}`, {
      name: 'Updated Pipeline',
      max_input_size_bytes: 10485760,
    });
    expect(status).toBe(200);
    expect((data['extraction-pipeline'] as Record<string, unknown>)?.['name']).toBe('Updated Pipeline');
  });

  it('deletes an extraction pipeline', async () => {
    const { status, data } = await api('DELETE', `/api/admin/extraction-pipelines/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Artifact Policies ────────────────────────────────

describeAdmin('Admin Artifact Policies', () => {
  let itemId: string;

  it('lists artifact policies', async () => {
    const { status, data } = await api('GET', '/api/admin/artifact-policies');
    expect(status).toBe(200);
    expect(Array.isArray(data['artifact-policies'])).toBe(true);
  });

  it('creates an artifact policy', async () => {
    const { status, data } = await api('POST', '/api/admin/artifact-policies', {
      name: 'Test Artifact Policy',
      description: 'Integration test artifact policy',
      max_size_bytes: 104857600,
      allowed_types: ['text', 'json', 'csv', 'image'],
      retention_days: 90,
      require_versioning: true,
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['artifact-policy'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets an artifact policy by id', async () => {
    const { status, data } = await api('GET', `/api/admin/artifact-policies/${itemId}`);
    expect(status).toBe(200);
    expect((data['artifact-policy'] as Record<string, unknown>)?.['name']).toBe('Test Artifact Policy');
  });

  it('updates an artifact policy', async () => {
    const { status, data } = await api('PUT', `/api/admin/artifact-policies/${itemId}`, {
      name: 'Updated Artifact Policy',
      retention_days: 180,
    });
    expect(status).toBe(200);
    expect((data['artifact-policy'] as Record<string, unknown>)?.['name']).toBe('Updated Artifact Policy');
  });

  it('deletes an artifact policy', async () => {
    const { status, data } = await api('DELETE', `/api/admin/artifact-policies/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Reliability Policies ─────────────────────────────

describeAdmin('Admin Reliability Policies', () => {
  let itemId: string;

  it('lists reliability policies', async () => {
    const { status, data } = await api('GET', '/api/admin/reliability-policies');
    expect(status).toBe(200);
    expect(Array.isArray(data['reliability-policies'])).toBe(true);
  });

  it('creates a reliability policy', async () => {
    const { status, data } = await api('POST', '/api/admin/reliability-policies', {
      name: 'Test Retry Policy',
      description: 'Integration test reliability policy',
      policy_type: 'retry',
      max_retries: 3,
      initial_delay_ms: 1000,
      max_delay_ms: 30000,
      backoff_multiplier: 2.0,
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['reliability-policy'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a reliability policy by id', async () => {
    const { status, data } = await api('GET', `/api/admin/reliability-policies/${itemId}`);
    expect(status).toBe(200);
    expect((data['reliability-policy'] as Record<string, unknown>)?.['name']).toBe('Test Retry Policy');
  });

  it('updates a reliability policy', async () => {
    const { status, data } = await api('PUT', `/api/admin/reliability-policies/${itemId}`, {
      name: 'Updated Retry Policy',
      max_retries: 5,
    });
    expect(status).toBe(200);
    expect((data['reliability-policy'] as Record<string, unknown>)?.['name']).toBe('Updated Retry Policy');
  });

  it('deletes a reliability policy', async () => {
    const { status, data } = await api('DELETE', `/api/admin/reliability-policies/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Collaboration Sessions ───────────────────────────

describeAdmin('Admin Collaboration Sessions', () => {
  let itemId: string;

  it('lists collaboration sessions', async () => {
    const { status, data } = await api('GET', '/api/admin/collaboration-sessions');
    expect(status).toBe(200);
    expect(Array.isArray(data['collaboration-sessions'])).toBe(true);
  });

  it('creates a collaboration session', async () => {
    const { status, data } = await api('POST', '/api/admin/collaboration-sessions', {
      name: 'Test Pair Session',
      description: 'Integration test collaboration session',
      session_type: 'pair',
      max_participants: 2,
      presence_ttl_ms: 30000,
      auto_close_idle_ms: 300000,
      handoff_enabled: true,
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['collaboration-session'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a collaboration session by id', async () => {
    const { status, data } = await api('GET', `/api/admin/collaboration-sessions/${itemId}`);
    expect(status).toBe(200);
    expect((data['collaboration-session'] as Record<string, unknown>)?.['name']).toBe('Test Pair Session');
  });

  it('updates a collaboration session', async () => {
    const { status, data } = await api('PUT', `/api/admin/collaboration-sessions/${itemId}`, {
      name: 'Updated Pair Session',
      max_participants: 4,
    });
    expect(status).toBe(200);
    expect((data['collaboration-session'] as Record<string, unknown>)?.['name']).toBe('Updated Pair Session');
  });

  it('deletes a collaboration session', async () => {
    const { status, data } = await api('DELETE', `/api/admin/collaboration-sessions/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Compliance Rules ─────────────────────────────────

describeAdmin('Admin Compliance Rules', () => {
  let itemId: string;

  it('lists compliance rules', async () => {
    const { status, data } = await api('GET', '/api/admin/compliance-rules');
    expect(status).toBe(200);
    expect(Array.isArray(data['compliance-rules'])).toBe(true);
  });

  it('creates a compliance rule', async () => {
    const { status, data } = await api('POST', '/api/admin/compliance-rules', {
      name: 'Test Retention Rule',
      description: 'Integration test compliance rule',
      rule_type: 'retention',
      target_resource: 'chat-logs',
      retention_days: 90,
      region: 'us-east-1',
      consent_purpose: '',
      action: 'archive',
      config: '{}',
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['compliance-rule'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a compliance rule by id', async () => {
    const { status, data } = await api('GET', `/api/admin/compliance-rules/${itemId}`);
    expect(status).toBe(200);
    expect((data['compliance-rule'] as Record<string, unknown>)?.['name']).toBe('Test Retention Rule');
  });

  it('updates a compliance rule', async () => {
    const { status, data } = await api('PUT', `/api/admin/compliance-rules/${itemId}`, {
      name: 'Updated Retention Rule',
      retention_days: 180,
    });
    expect(status).toBe(200);
    expect((data['compliance-rule'] as Record<string, unknown>)?.['name']).toBe('Updated Retention Rule');
  });

  it('deletes a compliance rule', async () => {
    const { status, data } = await api('DELETE', `/api/admin/compliance-rules/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Graph Configs ────────────────────────────────────

describeAdmin('Admin Graph Configs', () => {
  let itemId: string;

  it('lists graph configs', async () => {
    const { status, data } = await api('GET', '/api/admin/graph-configs');
    expect(status).toBe(200);
    expect(Array.isArray(data['graph-configs'])).toBe(true);
  });

  it('creates a graph config', async () => {
    const { status, data } = await api('POST', '/api/admin/graph-configs', {
      name: 'Test Entity Graph',
      description: 'Integration test graph config',
      graph_type: 'entity',
      max_depth: 3,
      entity_types: '["person","org"]',
      relationship_types: '["works_for","manages"]',
      auto_link: true,
      scoring_weights: '{"relevance":0.7,"recency":0.3}',
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['graph-config'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a graph config by id', async () => {
    const { status, data } = await api('GET', `/api/admin/graph-configs/${itemId}`);
    expect(status).toBe(200);
    expect((data['graph-config'] as Record<string, unknown>)?.['name']).toBe('Test Entity Graph');
  });

  it('updates a graph config', async () => {
    const { status, data } = await api('PUT', `/api/admin/graph-configs/${itemId}`, {
      name: 'Updated Entity Graph',
      max_depth: 5,
    });
    expect(status).toBe(200);
    expect((data['graph-config'] as Record<string, unknown>)?.['name']).toBe('Updated Entity Graph');
  });

  it('deletes a graph config', async () => {
    const { status, data } = await api('DELETE', `/api/admin/graph-configs/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Plugin Configs ───────────────────────────────────

describeAdmin('Admin Plugin Configs', () => {
  let itemId: string;

  it('lists plugin configs', async () => {
    const { status, data } = await api('GET', '/api/admin/plugin-configs');
    expect(status).toBe(200);
    expect(Array.isArray(data['plugin-configs'])).toBe(true);
  });

  it('creates a plugin config', async () => {
    const { status, data } = await api('POST', '/api/admin/plugin-configs', {
      name: 'Test Plugin',
      description: 'Integration test plugin config',
      plugin_type: 'community',
      package_name: '@test/plugin-hello',
      version: '1.0.0',
      capabilities: '["chat","tools"]',
      trust_level: 'sandboxed',
      auto_update: false,
      config: '{"timeout":5000}',
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['plugin-config'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a plugin config by id', async () => {
    const { status, data } = await api('GET', `/api/admin/plugin-configs/${itemId}`);
    expect(status).toBe(200);
    expect((data['plugin-config'] as Record<string, unknown>)?.['name']).toBe('Test Plugin');
  });

  it('updates a plugin config', async () => {
    const { status, data } = await api('PUT', `/api/admin/plugin-configs/${itemId}`, {
      name: 'Updated Plugin',
      version: '2.0.0',
    });
    expect(status).toBe(200);
    expect((data['plugin-config'] as Record<string, unknown>)?.['name']).toBe('Updated Plugin');
  });

  it('deletes a plugin config', async () => {
    const { status, data } = await api('DELETE', `/api/admin/plugin-configs/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Scaffold Templates ───────────────────────────────

describeAdmin('Admin Scaffold Templates', () => {
  let itemId: string;

  it('lists scaffold templates', async () => {
    const { status, data } = await api('GET', '/api/admin/scaffold-templates');
    expect(status).toBe(200);
    expect(Array.isArray(data['scaffold-templates'])).toBe(true);
  });

  it('creates a scaffold template', async () => {
    const { status, data } = await api('POST', '/api/admin/scaffold-templates', {
      name: 'Test Scaffold',
      description: 'Integration test scaffold template',
      template_type: 'basic-agent',
      files: '{"index.ts":"console.log()"}',
      dependencies: '{"@weaveintel/core":"*"}',
      dev_dependencies: '{"typescript":"^5"}',
      variables: '{"name":"my-agent"}',
      post_install: 'npm install',
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['scaffold-template'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a scaffold template by id', async () => {
    const { status, data } = await api('GET', `/api/admin/scaffold-templates/${itemId}`);
    expect(status).toBe(200);
    expect((data['scaffold-template'] as Record<string, unknown>)?.['name']).toBe('Test Scaffold');
  });

  it('updates a scaffold template', async () => {
    const { status, data } = await api('PUT', `/api/admin/scaffold-templates/${itemId}`, {
      name: 'Updated Scaffold',
      template_type: 'rag-pipeline',
    });
    expect(status).toBe(200);
    expect((data['scaffold-template'] as Record<string, unknown>)?.['name']).toBe('Updated Scaffold');
  });

  it('deletes a scaffold template', async () => {
    const { status, data } = await api('DELETE', `/api/admin/scaffold-templates/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Recipe Configs ───────────────────────────────────

describeAdmin('Admin Recipe Configs', () => {
  let itemId: string;

  it('lists recipe configs', async () => {
    const { status, data } = await api('GET', '/api/admin/recipe-configs');
    expect(status).toBe(200);
    expect(Array.isArray(data['recipe-configs'])).toBe(true);
  });

  it('creates a recipe config', async () => {
    const { status, data } = await api('POST', '/api/admin/recipe-configs', {
      name: 'Test Recipe',
      description: 'Integration test recipe config',
      recipe_type: 'workflow',
      model: 'gpt-4o',
      provider: 'openai',
      system_prompt: 'You are a test agent',
      tools: '["search","calculate"]',
      guardrails: '["pii-filter"]',
      max_steps: 5,
      options: '{"verbose":true}',
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['recipe-config'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a recipe config by id', async () => {
    const { status, data } = await api('GET', `/api/admin/recipe-configs/${itemId}`);
    expect(status).toBe(200);
    expect((data['recipe-config'] as Record<string, unknown>)?.['name']).toBe('Test Recipe');
  });

  it('updates a recipe config', async () => {
    const { status, data } = await api('PUT', `/api/admin/recipe-configs/${itemId}`, {
      name: 'Updated Recipe',
      max_steps: 20,
    });
    expect(status).toBe(200);
    expect((data['recipe-config'] as Record<string, unknown>)?.['name']).toBe('Updated Recipe');
  });

  it('deletes a recipe config', async () => {
    const { status, data } = await api('DELETE', `/api/admin/recipe-configs/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Widget Configs ───────────────────────────────────

describeAdmin('Admin Widget Configs', () => {
  let itemId: string;

  it('lists widget configs', async () => {
    const { status, data } = await api('GET', '/api/admin/widget-configs');
    expect(status).toBe(200);
    expect(Array.isArray(data['widget-configs'])).toBe(true);
  });

  it('creates a widget config', async () => {
    const { status, data } = await api('POST', '/api/admin/widget-configs', {
      name: 'Test Widget',
      description: 'Integration test widget config',
      widget_type: 'chart',
      default_options: '{"theme":"dark"}',
      allowed_contexts: '["dashboard","chat"]',
      max_data_points: 100,
      refresh_interval_ms: 5000,
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['widget-config'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a widget config by id', async () => {
    const { status, data } = await api('GET', `/api/admin/widget-configs/${itemId}`);
    expect(status).toBe(200);
    expect((data['widget-config'] as Record<string, unknown>)?.['name']).toBe('Test Widget');
  });

  it('updates a widget config', async () => {
    const { status, data } = await api('PUT', `/api/admin/widget-configs/${itemId}`, {
      name: 'Updated Widget',
      max_data_points: 500,
    });
    expect(status).toBe(200);
    expect((data['widget-config'] as Record<string, unknown>)?.['name']).toBe('Updated Widget');
  });

  it('deletes a widget config', async () => {
    const { status, data } = await api('DELETE', `/api/admin/widget-configs/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});

// ─── Admin Validation Rules ─────────────────────────────────

describeAdmin('Admin Validation Rules', () => {
  let itemId: string;

  it('lists validation rules', async () => {
    const { status, data } = await api('GET', '/api/admin/validation-rules');
    expect(status).toBe(200);
    expect(Array.isArray(data['validation-rules'])).toBe(true);
  });

  it('creates a validation rule', async () => {
    const { status, data } = await api('POST', '/api/admin/validation-rules', {
      name: 'Test Rule',
      description: 'Integration test validation rule',
      rule_type: 'required',
      target: 'agent-config',
      condition: '{"field":"name","op":"not_empty"}',
      severity: 'error',
      message: 'Name is required',
      enabled: true,
    });
    expect(status).toBe(201);
    const item = data['validation-rule'] as Record<string, unknown>;
    expect(item?.['id']).toBeDefined();
    itemId = item['id'] as string;
  });

  it('gets a validation rule by id', async () => {
    const { status, data } = await api('GET', `/api/admin/validation-rules/${itemId}`);
    expect(status).toBe(200);
    expect((data['validation-rule'] as Record<string, unknown>)?.['name']).toBe('Test Rule');
  });

  it('updates a validation rule', async () => {
    const { status, data } = await api('PUT', `/api/admin/validation-rules/${itemId}`, {
      name: 'Updated Rule',
      severity: 'warning',
    });
    expect(status).toBe(200);
    expect((data['validation-rule'] as Record<string, unknown>)?.['name']).toBe('Updated Rule');
  });

  it('deletes a validation rule', async () => {
    const { status, data } = await api('DELETE', `/api/admin/validation-rules/${itemId}`);
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});
