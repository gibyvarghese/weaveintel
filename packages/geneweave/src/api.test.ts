/**
 * @weaveintel/geneweave — API integration tests
 *
 * Tests run against the deployed Azure API.
 * Requires the server to be running at BASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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
  let promptId: string;

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
});

// ─── Prompt Resolution ──────────────────────────────────────

describe('Prompt Resolution', () => {
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

describe('Admin Routing', () => {
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

describe('Routing Active', () => {
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

// ─── Admin: Cache Policies CRUD ─────────────────────────────

describe('Admin Cache Policies', () => {
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

describe('Admin Identity Rules', () => {
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

describe('Admin Memory Governance', () => {
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

describe('Seed', () => {
  it('seeds default data', async () => {
    const { status, data } = await api('POST', '/api/admin/seed');
    expect(status).toBe(200);
    expect(data['ok']).toBe(true);
  });
});
