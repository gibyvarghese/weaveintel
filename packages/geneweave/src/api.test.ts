/**
 * @weaveintel/geneweave — API integration tests
 *
 * Tests run against the deployed Azure API.
 * Requires the server to be running at BASE_URL.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env['API_URL'] ?? 'https://anyweave-api.livelyrock-3622bbbd.westus2.azurecontainerapps.io';

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

  // Capture Set-Cookie header
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/gw_token=([^;]+)/);
    if (match) cookie = `gw_token=${match[1]}`;
  }

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, data };
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
    expect(status).toBe(201);
    expect(data['user']).toBeDefined();
    expect(data['csrfToken']).toBeDefined();
    csrfToken = data['csrfToken'] as string;
  });

  it('returns current user', async () => {
    const { status, data } = await api('GET', '/api/auth/me');
    expect(status).toBe(200);
    expect(data['user']).toBeDefined();
  });

  it('logs out and re-logs in', async () => {
    await api('POST', '/api/auth/logout');
    cookie = '';
    csrfToken = '';

    const { status, data } = await api('POST', '/api/auth/login', {
      email: testEmail,
      password: testPassword,
    });
    expect(status).toBe(200);
    expect(data['csrfToken']).toBeDefined();
    csrfToken = data['csrfToken'] as string;
  });
});

// ─── Admin: Guardrails CRUD ──────────────────────────────────

describe('Admin Guardrails', () => {
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

describe('Admin Workflows', () => {
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
    const { status, data } = await api('GET', '/api/workflow-runs');
    expect(status).toBe(200);
    expect(Array.isArray(data['runs'])).toBe(true);
  });

  it('creates a workflow run', async () => {
    const { status, data } = await api('POST', '/api/workflow-runs', {
      workflow_id: 'test-wf',
      input: { msg: 'hello' },
    });
    expect(status).toBe(201);
    expect(data['id']).toBeDefined();
    runId = data['id'] as string;
  });

  it('gets a workflow run by id', async () => {
    const { status, data } = await api('GET', `/api/workflow-runs/${runId}`);
    expect(status).toBe(200);
    expect((data['run'] as Record<string, unknown>)?.['id']).toBe(runId);
  });

  it('updates a workflow run status', async () => {
    const { status } = await api('PUT', `/api/workflow-runs/${runId}`, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    expect(status).toBe(200);
  });
});

// ─── Guardrail Evaluations ──────────────────────────────────

describe('Guardrail Evaluations', () => {
  it('lists guardrail evaluations', async () => {
    const { status, data } = await api('GET', '/api/guardrail-evals');
    expect(status).toBe(200);
    expect(Array.isArray(data['evals'])).toBe(true);
  });

  it('supports limit parameter', async () => {
    const { status, data } = await api('GET', '/api/guardrail-evals?limit=5');
    expect(status).toBe(200);
    expect(Array.isArray(data['evals'])).toBe(true);
  });
});

// ─── Admin: Prompts CRUD ────────────────────────────────────

describe('Admin Prompts', () => {
  it('lists prompts', async () => {
    const { status, data } = await api('GET', '/api/admin/prompts');
    expect(status).toBe(200);
    expect(Array.isArray(data['prompts'])).toBe(true);
  });
});

// ─── Admin: Routing CRUD ────────────────────────────────────

describe('Admin Routing', () => {
  it('lists routing policies', async () => {
    const { status, data } = await api('GET', '/api/admin/routing');
    expect(status).toBe(200);
    expect(Array.isArray(data['policies'])).toBe(true);
  });
});

// ─── Admin: Tools CRUD ──────────────────────────────────────

describe('Admin Tools', () => {
  it('lists tools', async () => {
    const { status, data } = await api('GET', '/api/admin/tools');
    expect(status).toBe(200);
    expect(Array.isArray(data['tools'])).toBe(true);
  });
});

// ─── Models ─────────────────────────────────────────────────

describe('Models', () => {
  it('lists available models', async () => {
    const { status, data } = await api('GET', '/api/models');
    expect(status).toBe(200);
    expect(Array.isArray(data['models'])).toBe(true);
  });
});

// ─── Admin: Task Policies CRUD ──────────────────────────────

describe('Admin Task Policies', () => {
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

describe('Admin Contracts', () => {
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

// ─── Seed ───────────────────────────────────────────────────

describe('Seed', () => {
  it('seeds default data', async () => {
    const { status, data } = await api('POST', '/api/admin/seed');
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});
