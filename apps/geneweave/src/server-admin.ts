/**
 * @weaveintel/geneweave — Admin CRUD routes
 *
 * Registers all admin configuration endpoints (prompts, guardrails, routing, etc.)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  renderPromptRecord,
  resolvePromptRecordForExecution,
  evaluatePromptDatasetForRecord,
  comparePromptDatasetResults,
  createConstraintAppenderOptimizer,
  runPromptOptimization,
  createPromptCapabilityTelemetry,
} from '@weaveintel/prompts';
import {
  capabilityTelemetryToEvent,
  capabilityTelemetryToSpanAttributes,
} from '@weaveintel/observability';
import type { DatabaseAdapter } from './db.js';
import type { AuthContext } from './auth.js';
import {
  registerToolRoutes,
  registerToolPolicyRoutes,
  registerToolAuditRoutes,
  registerToolHealthRoutes,
  registerSkillRoutes,
  registerWorkerAgentRoutes,
  registerGuardrailRoutes,
  registerRoutingRoutes,
  registerModelPricingRoutes,
  registerWorkflowRoutes,
  registerTaskPolicyRoutes,
  registerTaskContractRoutes,
  registerIdentityRuleRoutes,
  registerMemoryGovernanceRoutes,
  registerComplianceRuleRoutes,
} from './admin/api/index.js';
import {
  normalizePromptVariables,
  normalizeJsonField,
  parseJsonValue,
  validateDetailedDescription,
  clearDefaultPromptExcept,
  safeParsePromptVariables,
} from './admin/api/admin-route-helpers.js';

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: AuthContext | null,
) => Promise<void>;

interface RouterLike {
  get(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void;
  post(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void;
  put(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void;
  del(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void;
}

export function registerAdminRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
  providers?: Record<string, { apiKey: string }>,
  html?: (res: ServerResponse, status: number, body: string) => void,
): void {
  // Local html helper fallback
  const htmlResp = html ?? ((res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  function requireDetailedDescription(
    description: unknown,
    kind: 'prompt' | 'tool' | 'skill' | 'agent',
    res: ServerResponse,
  ): string | null {
    const validation = validateDetailedDescription(description, kind);
    if (!validation.valid) {
      json(res, 400, { error: validation.error });
      return null;
    }
    return validation.description;
  }
  // ── Admin: Prompts ──────────────────────────────────────────

  router.get('/api/admin/prompts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const prompts = await db.listPrompts();
    json(res, 200, { prompts });
  });

  router.get('/api/admin/prompts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const prompt = await db.getPrompt(params['id']!);
    if (!prompt) { json(res, 404, { error: 'Prompt not found' }); return; }
    json(res, 200, { prompt });
  });

  router.post('/api/admin/prompts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['template']) { json(res, 400, { error: 'name and template required' }); return; }
    const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
    if (!validatedDescription) return;
    const id = randomUUID();
    const isDefault = body['is_default'] ? 1 : 0;
    await db.createPrompt({
      id, key: (body['key'] as string) ?? id, name: body['name'] as string, description: validatedDescription,
      category: (body['category'] as string) ?? null, prompt_type: (body['prompt_type'] as string) ?? 'template', owner: (body['owner'] as string) ?? null, status: (body['status'] as string) ?? 'published', tags: normalizeJsonField(body['tags']), template: body['template'] as string,
      variables: normalizePromptVariables(body['variables']),
      version: (body['version'] as string) ?? '1.0', model_compatibility: normalizeJsonField(body['model_compatibility']), execution_defaults: normalizeJsonField(body['execution_defaults']), framework: normalizeJsonField(body['framework']), metadata: normalizeJsonField(body['metadata']), is_default: isDefault, enabled: body['enabled'] !== false ? 1 : 0,
    });
    if (isDefault) await clearDefaultPromptExcept(db, id);
    const prompt = await db.getPrompt(id);
    json(res, 201, { prompt });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPrompt(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['prompt_type'] !== undefined) fields['prompt_type'] = body['prompt_type'];
    if (body['owner'] !== undefined) fields['owner'] = body['owner'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['tags'] !== undefined) fields['tags'] = normalizeJsonField(body['tags']);
    if (body['template'] !== undefined) fields['template'] = body['template'];
    if (body['variables'] !== undefined) fields['variables'] = normalizePromptVariables(body['variables']);
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['model_compatibility'] !== undefined) fields['model_compatibility'] = normalizeJsonField(body['model_compatibility']);
    if (body['execution_defaults'] !== undefined) fields['execution_defaults'] = normalizeJsonField(body['execution_defaults']);
    if (body['framework'] !== undefined) fields['framework'] = normalizeJsonField(body['framework']);
    if (body['metadata'] !== undefined) fields['metadata'] = normalizeJsonField(body['metadata']);
    if (body['is_default'] !== undefined) fields['is_default'] = body['is_default'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePrompt(params['id']!, fields as any);
    if (body['is_default']) await clearDefaultPromptExcept(db, params['id']!);
    const prompt = await db.getPrompt(params['id']!);
    json(res, 200, { prompt });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePrompt(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Frameworks (Phase 2) ────────────────────

  router.get('/api/admin/prompt-frameworks', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const frameworks = await db.listPromptFrameworks();
    json(res, 200, { frameworks });
  });

  router.get('/api/admin/prompt-frameworks/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const f = await db.getPromptFramework(params['id']!);
    if (!f) { json(res, 404, { error: 'Prompt framework not found' }); return; }
    json(res, 200, { framework: f });
  });

  router.post('/api/admin/prompt-frameworks', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name']) { json(res, 400, { error: 'key and name required' }); return; }
    const id = randomUUID();
    await db.createPromptFramework({
      id, key: body['key'] as string, name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      sections: body['sections'] ? JSON.stringify(body['sections']) : '[]',
      section_separator: (body['section_separator'] as string) ?? '\n\n',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const framework = await db.getPromptFramework(id);
    json(res, 201, { framework });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-frameworks/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptFramework(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt framework not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['sections'] !== undefined) fields['sections'] = typeof body['sections'] === 'string' ? body['sections'] : JSON.stringify(body['sections']);
    if (body['section_separator'] !== undefined) fields['section_separator'] = body['section_separator'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptFramework(params['id']!, fields as any);
    const framework = await db.getPromptFramework(params['id']!);
    json(res, 200, { framework });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-frameworks/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptFramework(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Fragments (Phase 2) ─────────────────────

  router.get('/api/admin/prompt-fragments', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const fragments = await db.listPromptFragments();
    json(res, 200, { fragments });
  });

  router.get('/api/admin/prompt-fragments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const f = await db.getPromptFragment(params['id']!);
    if (!f) { json(res, 404, { error: 'Prompt fragment not found' }); return; }
    json(res, 200, { fragment: f });
  });

  router.post('/api/admin/prompt-fragments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name'] || !body['content']) {
      json(res, 400, { error: 'key, name, and content required' }); return;
    }
    const id = randomUUID();
    await db.createPromptFragment({
      id, key: body['key'] as string, name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      category: (body['category'] as string) ?? null,
      content: body['content'] as string,
      variables: body['variables'] ? JSON.stringify(body['variables']) : null,
      tags: body['tags'] ? JSON.stringify(body['tags']) : null,
      version: (body['version'] as string) ?? '1.0',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const fragment = await db.getPromptFragment(id);
    json(res, 201, { fragment });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-fragments/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptFragment(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt fragment not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['content'] !== undefined) fields['content'] = body['content'];
    if (body['variables'] !== undefined) fields['variables'] = typeof body['variables'] === 'string' ? body['variables'] : JSON.stringify(body['variables']);
    if (body['tags'] !== undefined) fields['tags'] = typeof body['tags'] === 'string' ? body['tags'] : JSON.stringify(body['tags']);
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptFragment(params['id']!, fields as any);
    const fragment = await db.getPromptFragment(params['id']!);
    json(res, 200, { fragment });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-fragments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptFragment(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Contracts ────────────────────────────────

  router.get('/api/admin/prompt-contracts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const contracts = await db.listPromptContracts();
    json(res, 200, { contracts });
  });

  router.get('/api/admin/prompt-contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getPromptContract(params['id']!);
    if (!c) { json(res, 404, { error: 'Prompt contract not found' }); return; }
    json(res, 200, { contract: c });
  });

  router.post('/api/admin/prompt-contracts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name'] || !body['contract_type'] || !body['config']) {
      json(res, 400, { error: 'key, name, contract_type, and config required' }); return;
    }
    const id = randomUUID();
    await db.createPromptContract({
      id, key: body['key'] as string, name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      contract_type: body['contract_type'] as string,
      schema: body['schema'] ? (typeof body['schema'] === 'string' ? body['schema'] : JSON.stringify(body['schema'])) : null,
      config: typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']),
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const contract = await db.getPromptContract(id);
    json(res, 201, { contract });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-contracts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptContract(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt contract not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['contract_type'] !== undefined) fields['contract_type'] = body['contract_type'];
    if (body['schema'] !== undefined) fields['schema'] = typeof body['schema'] === 'string' ? body['schema'] : JSON.stringify(body['schema']);
    if (body['config'] !== undefined) fields['config'] = typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptContract(params['id']!, fields as any);
    const contract = await db.getPromptContract(params['id']!);
    json(res, 200, { contract });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptContract(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Strategies (Phase 4) ───────────────────

  router.get('/api/admin/prompt-strategies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const strategies = await db.listPromptStrategies();
    json(res, 200, { strategies });
  });

  router.get('/api/admin/prompt-strategies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const strategy = await db.getPromptStrategy(params['id']!);
    if (!strategy) { json(res, 404, { error: 'Prompt strategy not found' }); return; }
    json(res, 200, { strategy });
  });

  router.post('/api/admin/prompt-strategies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name']) {
      json(res, 400, { error: 'key and name required' }); return;
    }
    const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
    if (!validatedDescription) return;

    const id = randomUUID();
    await db.createPromptStrategy({
      id,
      key: body['key'] as string,
      name: body['name'] as string,
      description: validatedDescription,
      instruction_prefix: (body['instruction_prefix'] as string) ?? null,
      instruction_suffix: (body['instruction_suffix'] as string) ?? null,
      config: normalizeJsonField(body['config']) ?? '{}',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const strategy = await db.getPromptStrategy(id);
    json(res, 201, { strategy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-strategies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptStrategy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt strategy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['instruction_prefix'] !== undefined) fields['instruction_prefix'] = body['instruction_prefix'];
    if (body['instruction_suffix'] !== undefined) fields['instruction_suffix'] = body['instruction_suffix'];
    if (body['config'] !== undefined) fields['config'] = normalizeJsonField(body['config']) ?? '{}';
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updatePromptStrategy(params['id']!, fields as any);
    const strategy = await db.getPromptStrategy(params['id']!);
    json(res, 200, { strategy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-strategies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptStrategy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Versions (Phase 5) ─────────────────────

  router.get('/api/admin/prompt-versions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const promptId = url.searchParams.get('prompt_id') ?? undefined;
    const versions = await db.listPromptVersions(promptId);
    json(res, 200, { versions });
  });

  router.get('/api/admin/prompt-versions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const version = await db.getPromptVersion(params['id']!);
    if (!version) { json(res, 404, { error: 'Prompt version not found' }); return; }
    json(res, 200, { version });
  });

  router.post('/api/admin/prompt-versions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['prompt_id'] || !body['version'] || !body['template']) {
      json(res, 400, { error: 'prompt_id, version, and template required' }); return;
    }
    const id = randomUUID();
    await db.createPromptVersion({
      id,
      prompt_id: body['prompt_id'] as string,
      version: body['version'] as string,
      status: (body['status'] as string) ?? 'draft',
      template: body['template'] as string,
      variables: normalizePromptVariables(body['variables']),
      model_compatibility: normalizeJsonField(body['model_compatibility']),
      execution_defaults: normalizeJsonField(body['execution_defaults']),
      framework: normalizeJsonField(body['framework']),
      metadata: normalizeJsonField(body['metadata']),
      is_active: body['is_active'] ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const version = await db.getPromptVersion(id);
    json(res, 201, { version });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-versions/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptVersion(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt version not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['template'] !== undefined) fields['template'] = body['template'];
    if (body['variables'] !== undefined) fields['variables'] = normalizePromptVariables(body['variables']);
    if (body['model_compatibility'] !== undefined) fields['model_compatibility'] = normalizeJsonField(body['model_compatibility']);
    if (body['execution_defaults'] !== undefined) fields['execution_defaults'] = normalizeJsonField(body['execution_defaults']);
    if (body['framework'] !== undefined) fields['framework'] = normalizeJsonField(body['framework']);
    if (body['metadata'] !== undefined) fields['metadata'] = normalizeJsonField(body['metadata']);
    if (body['is_active'] !== undefined) fields['is_active'] = body['is_active'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptVersion(params['id']!, fields as any);
    const version = await db.getPromptVersion(params['id']!);
    json(res, 200, { version });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-versions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptVersion(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Experiments (Phase 5) ───────────────────

  router.get('/api/admin/prompt-experiments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const promptId = url.searchParams.get('prompt_id') ?? undefined;
    const experiments = await db.listPromptExperiments(promptId);
    json(res, 200, { experiments });
  });

  router.get('/api/admin/prompt-experiments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const experiment = await db.getPromptExperiment(params['id']!);
    if (!experiment) { json(res, 404, { error: 'Prompt experiment not found' }); return; }
    json(res, 200, { experiment });
  });

  router.post('/api/admin/prompt-experiments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['prompt_id'] || !body['name'] || !body['variants_json']) {
      json(res, 400, { error: 'prompt_id, name, and variants_json required' }); return;
    }
    const id = randomUUID();
    await db.createPromptExperiment({
      id,
      prompt_id: body['prompt_id'] as string,
      name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      status: (body['status'] as string) ?? 'draft',
      variants_json: typeof body['variants_json'] === 'string' ? body['variants_json'] : JSON.stringify(body['variants_json']),
      assignment_key_template: (body['assignment_key_template'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const experiment = await db.getPromptExperiment(id);
    json(res, 201, { experiment });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-experiments/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptExperiment(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt experiment not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['variants_json'] !== undefined) fields['variants_json'] = typeof body['variants_json'] === 'string' ? body['variants_json'] : JSON.stringify(body['variants_json']);
    if (body['assignment_key_template'] !== undefined) fields['assignment_key_template'] = body['assignment_key_template'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptExperiment(params['id']!, fields as any);
    const experiment = await db.getPromptExperiment(params['id']!);
    json(res, 200, { experiment });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-experiments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptExperiment(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Eval Datasets (Phase 7) ────────────────

  router.get('/api/admin/prompt-eval-datasets', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const promptId = url.searchParams.get('prompt_id') ?? undefined;
    const datasets = await db.listPromptEvalDatasets(promptId);
    json(res, 200, { datasets });
  });

  router.get('/api/admin/prompt-eval-datasets/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const dataset = await db.getPromptEvalDataset(params['id']!);
    if (!dataset) { json(res, 404, { error: 'Prompt eval dataset not found' }); return; }
    json(res, 200, { dataset });
  });

  router.post('/api/admin/prompt-eval-datasets', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['prompt_id'] || !body['name'] || !body['cases_json']) {
      json(res, 400, { error: 'prompt_id, name, and cases_json required' }); return;
    }
    const id = randomUUID();
    await db.createPromptEvalDataset({
      id,
      prompt_id: body['prompt_id'] as string,
      name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      prompt_version: (body['prompt_version'] as string) ?? null,
      status: (body['status'] as string) ?? 'draft',
      pass_threshold: typeof body['pass_threshold'] === 'number' ? body['pass_threshold'] as number : 0.75,
      cases_json: typeof body['cases_json'] === 'string' ? body['cases_json'] : JSON.stringify(body['cases_json']),
      rubric_json: normalizeJsonField(body['rubric_json']),
      metadata: normalizeJsonField(body['metadata']),
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const dataset = await db.getPromptEvalDataset(id);
    json(res, 201, { dataset });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-eval-datasets/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptEvalDataset(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt eval dataset not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['prompt_version'] !== undefined) fields['prompt_version'] = body['prompt_version'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['pass_threshold'] !== undefined) fields['pass_threshold'] = body['pass_threshold'];
    if (body['cases_json'] !== undefined) fields['cases_json'] = typeof body['cases_json'] === 'string' ? body['cases_json'] : JSON.stringify(body['cases_json']);
    if (body['rubric_json'] !== undefined) fields['rubric_json'] = normalizeJsonField(body['rubric_json']);
    if (body['metadata'] !== undefined) fields['metadata'] = normalizeJsonField(body['metadata']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updatePromptEvalDataset(params['id']!, fields as any);
    const dataset = await db.getPromptEvalDataset(params['id']!);
    json(res, 200, { dataset });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-eval-datasets/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptEvalDataset(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Eval Runs (Phase 7) ────────────────────

  router.get('/api/admin/prompt-eval-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const datasetId = url.searchParams.get('dataset_id') ?? undefined;
    const runs = await db.listPromptEvalRuns(datasetId);
    json(res, 200, { runs });
  });

  router.get('/api/admin/prompt-eval-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getPromptEvalRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Prompt eval run not found' }); return; }
    json(res, 200, { run });
  });

  router.post('/api/admin/prompt-eval-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['dataset_id'] || !body['prompt_id'] || !body['prompt_version'] || body['results_json'] === undefined) {
      json(res, 400, { error: 'dataset_id, prompt_id, prompt_version, and results_json required' }); return;
    }
    const id = randomUUID();
    await db.createPromptEvalRun({
      id,
      dataset_id: body['dataset_id'] as string,
      prompt_id: body['prompt_id'] as string,
      prompt_version: body['prompt_version'] as string,
      status: (body['status'] as string) ?? 'completed',
      avg_score: typeof body['avg_score'] === 'number' ? body['avg_score'] as number : 0,
      passed_cases: typeof body['passed_cases'] === 'number' ? body['passed_cases'] as number : 0,
      failed_cases: typeof body['failed_cases'] === 'number' ? body['failed_cases'] as number : 0,
      total_cases: typeof body['total_cases'] === 'number' ? body['total_cases'] as number : 0,
      results_json: typeof body['results_json'] === 'string' ? body['results_json'] : JSON.stringify(body['results_json']),
      summary_json: normalizeJsonField(body['summary_json']),
      metadata: normalizeJsonField(body['metadata']),
      completed_at: (body['completed_at'] as string) ?? null,
    });
    const run = await db.getPromptEvalRun(id);
    json(res, 201, { run });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-eval-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptEvalRun(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Optimizers (Phase 7) ───────────────────

  router.get('/api/admin/prompt-optimizers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const optimizers = await db.listPromptOptimizers();
    json(res, 200, { optimizers });
  });

  router.get('/api/admin/prompt-optimizers/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const optimizer = await db.getPromptOptimizer(params['id']!);
    if (!optimizer) { json(res, 404, { error: 'Prompt optimizer not found' }); return; }
    json(res, 200, { optimizer });
  });

  router.post('/api/admin/prompt-optimizers', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name']) {
      json(res, 400, { error: 'key and name required' }); return;
    }
    const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
    if (!validatedDescription) return;

    const id = randomUUID();
    await db.createPromptOptimizer({
      id,
      key: body['key'] as string,
      name: body['name'] as string,
      description: validatedDescription,
      implementation_kind: (body['implementation_kind'] as string) ?? 'rule',
      config: normalizeJsonField(body['config']) ?? '{}',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const optimizer = await db.getPromptOptimizer(id);
    json(res, 201, { optimizer });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-optimizers/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptOptimizer(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt optimizer not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['implementation_kind'] !== undefined) fields['implementation_kind'] = body['implementation_kind'];
    if (body['config'] !== undefined) fields['config'] = normalizeJsonField(body['config']) ?? '{}';
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updatePromptOptimizer(params['id']!, fields as any);
    const optimizer = await db.getPromptOptimizer(params['id']!);
    json(res, 200, { optimizer });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-optimizers/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptOptimizer(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Optimization Runs (Phase 7) ────────────

  router.get('/api/admin/prompt-optimization-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const promptId = url.searchParams.get('prompt_id') ?? undefined;
    const runs = await db.listPromptOptimizationRuns(promptId);
    json(res, 200, { runs });
  });

  router.get('/api/admin/prompt-optimization-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getPromptOptimizationRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Prompt optimization run not found' }); return; }
    json(res, 200, { run });
  });

  router.post('/api/admin/prompt-optimization-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['prompt_id'] || !body['source_version'] || !body['candidate_version'] || !body['objective'] || !body['source_template'] || !body['candidate_template'] || body['diff_json'] === undefined) {
      json(res, 400, { error: 'prompt_id, source_version, candidate_version, objective, source_template, candidate_template, and diff_json required' }); return;
    }
    const id = randomUUID();
    await db.createPromptOptimizationRun({
      id,
      prompt_id: body['prompt_id'] as string,
      source_version: body['source_version'] as string,
      candidate_version: body['candidate_version'] as string,
      optimizer_id: (body['optimizer_id'] as string) ?? null,
      objective: body['objective'] as string,
      source_template: body['source_template'] as string,
      candidate_template: body['candidate_template'] as string,
      diff_json: typeof body['diff_json'] === 'string' ? body['diff_json'] : JSON.stringify(body['diff_json']),
      eval_baseline_json: normalizeJsonField(body['eval_baseline_json']),
      eval_candidate_json: normalizeJsonField(body['eval_candidate_json']),
      status: (body['status'] as string) ?? 'completed',
      metadata: normalizeJsonField(body['metadata']),
    });
    const run = await db.getPromptOptimizationRun(id);
    json(res, 201, { run });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-optimization-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptOptimizationRun(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Phase 7 Runtime Execution Helpers ─────────────

  router.post('/api/admin/prompt-eval-datasets/:id/run', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const dataset = await db.getPromptEvalDataset(params['id']!);
    if (!dataset) { json(res, 404, { error: 'Prompt eval dataset not found' }); return; }

    const prompt = await db.getPrompt(dataset.prompt_id);
    if (!prompt) { json(res, 404, { error: 'Prompt not found for dataset.prompt_id' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    }

    const versions = await db.listPromptVersions(prompt.id);
    const experiments = await db.listPromptExperiments(prompt.id);
    const requestedVersion = (body['requested_version'] as string) ?? dataset.prompt_version ?? undefined;

    const resolved = resolvePromptRecordForExecution({
      prompt,
      versions,
      experiments,
      options: {
        requestedVersion,
        assignmentKey: (body['assignment_key'] as string) ?? undefined,
        experimentId: (body['experiment_id'] as string) ?? undefined,
      },
    });

    const evalDataset = {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description ?? 'Prompt evaluation dataset',
      promptId: dataset.prompt_id,
      promptVersion: dataset.prompt_version ?? undefined,
      cases: parseJsonValue(dataset.cases_json, [] as Array<Record<string, unknown>>),
      rubric: dataset.rubric_json ? parseJsonValue(dataset.rubric_json, [] as Array<Record<string, unknown>>) : undefined,
    };

    const result = await evaluatePromptDatasetForRecord(resolved.record, evalDataset as any, {
      passThreshold: typeof body['pass_threshold'] === 'number'
        ? body['pass_threshold'] as number
        : dataset.pass_threshold,
    });

    const runId = randomUUID();
    await db.createPromptEvalRun({
      id: runId,
      dataset_id: dataset.id,
      prompt_id: prompt.id,
      prompt_version: result.promptVersion,
      status: 'completed',
      avg_score: result.averageScore,
      passed_cases: result.passedCases,
      failed_cases: result.failedCases,
      total_cases: result.totalCases,
      results_json: JSON.stringify(result.results),
      summary_json: JSON.stringify({
        datasetName: result.datasetName,
        passThreshold: result.passThreshold,
        durationMs: result.durationMs,
      }),
      metadata: JSON.stringify({ resolution: resolved.meta }),
      completed_at: new Date().toISOString(),
    });

    const run = await db.getPromptEvalRun(runId);
    json(res, 200, { run, result, resolution: resolved.meta });
  }, { auth: true, csrf: true });

  router.post('/api/admin/prompts/:id/optimize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const prompt = await db.getPrompt(params['id']!);
    if (!prompt) { json(res, 404, { error: 'Prompt not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['objective']) { json(res, 400, { error: 'objective required' }); return; }

    const versions = await db.listPromptVersions(prompt.id);
    const experiments = await db.listPromptExperiments(prompt.id);
    const resolved = resolvePromptRecordForExecution({
      prompt,
      versions,
      experiments,
      options: {
        requestedVersion: (body['source_version'] as string) ?? undefined,
      },
    });

    const optimizerKey = (body['optimizer_key'] as string) ?? 'constraintAppender';
    const optimizerRecord = await db.getPromptOptimizerByKey(optimizerKey);
    const optimizerConfig = parseJsonValue<Record<string, unknown>>(optimizerRecord?.config ?? '{}', {});
    const optimizer = createConstraintAppenderOptimizer({
      key: optimizerKey,
      name: optimizerRecord?.name ?? 'Constraint Appender',
      description: optimizerRecord?.description ?? 'Deterministic optimizer profile for prompt constraints and format checks.',
      suffix: typeof optimizerConfig['suffix'] === 'string'
        ? optimizerConfig['suffix'] as string
        : 'Return output that follows the required format exactly and explains key decisions clearly.',
    });

    const optResult = await runPromptOptimization({
      prompt: resolved.record,
      optimizer,
      objective: body['objective'] as string,
      constraints: Array.isArray(body['constraints'])
        ? body['constraints'].filter((item): item is string => typeof item === 'string')
        : undefined,
      targetVersion: (body['candidate_version'] as string) ?? undefined,
    });

    let evalBaselineJson: string | null = null;
    let evalCandidateJson: string | null = null;
    if (typeof body['dataset_id'] === 'string') {
      const dataset = await db.getPromptEvalDataset(body['dataset_id']);
      if (dataset) {
        const datasetObj = {
          id: dataset.id,
          name: dataset.name,
          description: dataset.description ?? 'Prompt optimization dataset',
          promptId: dataset.prompt_id,
          promptVersion: dataset.prompt_version ?? undefined,
          cases: parseJsonValue(dataset.cases_json, [] as Array<Record<string, unknown>>),
          rubric: dataset.rubric_json ? parseJsonValue(dataset.rubric_json, [] as Array<Record<string, unknown>>) : undefined,
        };

        const candidateRecord = {
          ...resolved.record,
          version: optResult.candidate.version,
          template: optResult.candidate.template,
          variables: optResult.candidate.variables ?? resolved.record.variables,
        };

        const comparison = await comparePromptDatasetResults({
          baselineRecord: resolved.record,
          candidateRecord,
          dataset: datasetObj as any,
          options: { passThreshold: dataset.pass_threshold },
        });
        evalBaselineJson = JSON.stringify(comparison.baseline);
        evalCandidateJson = JSON.stringify(comparison.candidate);
      }
    }

    const runId = randomUUID();
    await db.createPromptOptimizationRun({
      id: runId,
      prompt_id: prompt.id,
      source_version: optResult.source.version,
      candidate_version: optResult.candidate.version,
      optimizer_id: optimizerRecord?.id ?? null,
      objective: optResult.objective,
      source_template: optResult.source.template,
      candidate_template: optResult.candidate.template,
      diff_json: JSON.stringify(optResult.diff),
      eval_baseline_json: evalBaselineJson,
      eval_candidate_json: evalCandidateJson,
      status: 'completed',
      metadata: JSON.stringify({
        optimizerKey: optResult.optimizerKey,
        optimizerName: optResult.optimizerName,
        reasoning: optResult.reasoning,
        resolution: resolved.meta,
      }),
    });

    const run = await db.getPromptOptimizationRun(runId);
    json(res, 200, { run, optimization: optResult });
  }, { auth: true, csrf: true });

  // ── Prompt resolution ──────────────────────────────────────

  router.post('/api/prompts/resolve', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const promptId = body['promptId'] as string;
    if (!promptId) { json(res, 400, { error: 'promptId required' }); return; }
    const prompt = await db.getPrompt(promptId);
    if (!prompt) { json(res, 404, { error: 'Prompt not found' }); return; }
    const variables = (body['variables'] as Record<string, unknown>) ?? {};
    try {
      let telemetry = undefined;
      const renderedResult = renderPromptRecord(prompt, variables, {
        evaluations: [
          {
            id: 'prompt_not_empty',
            description: 'Rendered prompt previews should produce non-empty content for operators.',
            evaluate: ({ content }) => ({
              passed: content.trim().length > 0,
              score: content.trim().length > 0 ? 1 : 0,
              reason: content.trim().length > 0 ? undefined : 'Rendered prompt preview is empty',
            }),
          },
        ],
        hooks: {
          onTelemetry: ({ telemetry: emitted }) => {
            telemetry = emitted;
          },
        },
      });

      const traceId = randomUUID();
      const rootSpanId = randomUUID();
      const capability = telemetry ?? createPromptCapabilityTelemetry(renderedResult, { source: 'db' });
      await db.saveTrace({
        id: randomUUID(),
        userId: auth.userId,
        traceId,
        spanId: rootSpanId,
        name: 'admin.prompt.resolve',
        startTime: Date.now() - renderedResult.durationMs,
        endTime: Date.now(),
        status: 'ok',
        attributes: JSON.stringify({
          route: '/api/prompts/resolve',
          promptId,
          renderedCharacters: renderedResult.content.length,
        }),
      });
      await db.saveTrace({
        id: randomUUID(),
        userId: auth.userId,
        traceId,
        spanId: randomUUID(),
        parentSpanId: rootSpanId,
        name: `capability.prompt.${capability.key}`,
        startTime: Date.now() - renderedResult.durationMs,
        endTime: Date.now(),
        status: 'ok',
        attributes: JSON.stringify(capabilityTelemetryToSpanAttributes(capability)),
        events: JSON.stringify([capabilityTelemetryToEvent(capability, 'success')]),
      });

      json(res, 200, {
        rendered: renderedResult.content,
        template: prompt.template,
        variables: safeParsePromptVariables(prompt.variables),
        telemetry: capability,
        evaluations: renderedResult.evaluations,
        traceId,
      });
    } catch (e: unknown) {
      json(res, 400, { error: e instanceof Error ? e.message : 'Render error' });
    }
  }, { auth: true, csrf: true });

  // ── Routing test ───────────────────────────────────────────

  router.get('/api/routing/active', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.listRoutingPolicies();
    const active = policies.filter(p => p.enabled);
    json(res, 200, { active });
  });

  // ── Callable Capabilities (Tools, Skills, Worker Agents) ───

  const adminHelpers = { json, readBody, requireDetailedDescription };
  const adminHelpersWithProviders = { ...adminHelpers, providers };
  registerGuardrailRoutes(router, db, adminHelpers);
  registerRoutingRoutes(router, db, adminHelpers);
  registerModelPricingRoutes(router, db, adminHelpersWithProviders);
  registerWorkflowRoutes(router, db, adminHelpers);
  registerTaskPolicyRoutes(router, db, adminHelpers);
  registerTaskContractRoutes(router, db, adminHelpers);
  registerIdentityRuleRoutes(router, db, adminHelpers);
  registerMemoryGovernanceRoutes(router, db, adminHelpers);
  registerComplianceRuleRoutes(router, db, adminHelpers);
  registerToolRoutes(router, db, adminHelpers);
  registerToolPolicyRoutes(router, db, adminHelpers);
  registerToolAuditRoutes(router, db, adminHelpers);
  registerToolHealthRoutes(router, db, adminHelpers);
  registerSkillRoutes(router, db, adminHelpers);
  registerWorkerAgentRoutes(router, db, adminHelpers);

  // ── Workflow Runs ──────────────────────────────────────────

  router.get('/api/workflow-runs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const runs = await db.listWorkflowRuns();
    json(res, 200, { runs });
  });

  router.get('/api/workflow-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }
    json(res, 200, { run });
  });

  router.post('/api/workflow-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const workflow_id = body['workflow_id'] as string | undefined;
    const input = body['input'] as Record<string, unknown> | undefined;
    if (!workflow_id) { json(res, 400, { error: 'workflow_id is required' }); return; }
    const id = randomUUID();
    await db.createWorkflowRun({
      id,
      workflow_id,
      status: 'pending',
      state: JSON.stringify({ currentStepId: '', variables: input ?? {}, history: [] }),
      input: input ? JSON.stringify(input) : null,
      error: null,
      started_at: new Date().toISOString(),
    });
    json(res, 201, { ok: true, id });
  }, { auth: true, csrf: true });

  router.put('/api/workflow-runs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    const body = JSON.parse(raw) as Partial<Omit<import('./db.js').WorkflowRunRow, 'id' | 'started_at'>>;
    await db.updateWorkflowRun(params['id']!, body);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Guardrail Evaluations ──────────────────────────────────

  router.get('/api/guardrail-evals', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chatId = url.searchParams.get('chat_id') ?? undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const evals = await db.listGuardrailEvals(chatId, limit);
    json(res, 200, { evals });
  });

  // ── Memory Extraction Events ───────────────────────────────

  router.get('/api/memory-extraction-events', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chatId = url.searchParams.get('chat_id') ?? undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const events = await db.listMemoryExtractionEvents(chatId, limit);
    json(res, 200, { events });
  });

  router.get('/api/memory-extraction-events/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const event = await db.getMemoryExtractionEvent(params['id']!);
    if (!event) { json(res, 404, { error: 'Memory extraction event not found' }); return; }
    json(res, 200, { event });
  });

  // ── Admin: Cache Policies ──────────────────────────────────

  router.get('/api/admin/cache-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listCachePolicies();
    json(res, 200, { 'cache-policies': items });
  });

  router.get('/api/admin/cache-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getCachePolicy(params['id']!);
    if (!c) { json(res, 404, { error: 'Cache policy not found' }); return; }
    json(res, 200, { 'cache-policy': c });
  });

  router.post('/api/admin/cache-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createCachePolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      scope: (body['scope'] as string) ?? 'global',
      ttl_ms: (body['ttl_ms'] as number) ?? 300000,
      max_entries: (body['max_entries'] as number) ?? 1000,
      bypass_patterns: body['bypass_patterns'] ? (typeof body['bypass_patterns'] === 'string' ? body['bypass_patterns'] as string : JSON.stringify(body['bypass_patterns'])) : '[]',
      invalidate_on: body['invalidate_on'] ? (typeof body['invalidate_on'] === 'string' ? body['invalidate_on'] as string : JSON.stringify(body['invalidate_on'])) : '[]',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getCachePolicy(id);
    json(res, 201, { 'cache-policy': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/cache-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getCachePolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Cache policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['scope'] !== undefined) fields['scope'] = body['scope'];
    if (body['ttl_ms'] !== undefined) fields['ttl_ms'] = body['ttl_ms'];
    if (body['max_entries'] !== undefined) fields['max_entries'] = body['max_entries'];
    if (body['bypass_patterns'] !== undefined) fields['bypass_patterns'] = typeof body['bypass_patterns'] === 'string' ? body['bypass_patterns'] : JSON.stringify(body['bypass_patterns']);
    if (body['invalidate_on'] !== undefined) fields['invalidate_on'] = typeof body['invalidate_on'] === 'string' ? body['invalidate_on'] : JSON.stringify(body['invalidate_on']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateCachePolicy(params['id']!, fields as any);
    const item = await db.getCachePolicy(params['id']!);
    json(res, 200, { 'cache-policy': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/cache-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteCachePolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Memory Extraction Rules ────────────────────────

  router.get('/api/admin/memory-extraction-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const ruleType = url.searchParams.get('rule_type') ?? undefined;
    const items = await db.listMemoryExtractionRules(ruleType);
    json(res, 200, { 'memory-extraction-rules': items });
  });

  router.get('/api/admin/memory-extraction-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rule = await db.getMemoryExtractionRule(params['id']!);
    if (!rule) { json(res, 404, { error: 'Memory extraction rule not found' }); return; }
    json(res, 200, { 'memory-extraction-rule': rule });
  });

  router.post('/api/admin/memory-extraction-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['rule_type'] || !body['pattern']) {
      json(res, 400, { error: 'name, rule_type and pattern required' });
      return;
    }
    const id = randomUUID();
    await db.createMemoryExtractionRule({
      id,
      name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      rule_type: body['rule_type'] as string,
      entity_type: ((body['entity_type'] as string) || '').trim() || null,
      pattern: body['pattern'] as string,
      flags: (body['flags'] as string) ?? null,
      facts_template: body['facts_template']
        ? (typeof body['facts_template'] === 'string' ? body['facts_template'] as string : JSON.stringify(body['facts_template']))
        : null,
      priority: (body['priority'] as number) ?? 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getMemoryExtractionRule(id);
    json(res, 201, { 'memory-extraction-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/memory-extraction-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMemoryExtractionRule(params['id']!);
    if (!existing) { json(res, 404, { error: 'Memory extraction rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['rule_type'] !== undefined) fields['rule_type'] = body['rule_type'];
    if (body['entity_type'] !== undefined) fields['entity_type'] = ((body['entity_type'] as string) || '').trim() || null;
    if (body['pattern'] !== undefined) fields['pattern'] = body['pattern'];
    if (body['flags'] !== undefined) fields['flags'] = body['flags'];
    if (body['facts_template'] !== undefined) {
      fields['facts_template'] = typeof body['facts_template'] === 'string' ? body['facts_template'] : JSON.stringify(body['facts_template']);
    }
    if (body['priority'] !== undefined) fields['priority'] = body['priority'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateMemoryExtractionRule(params['id']!, fields as any);
    const item = await db.getMemoryExtractionRule(params['id']!);
    json(res, 200, { 'memory-extraction-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/memory-extraction-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteMemoryExtractionRule(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Search Providers ────────────────────────────────

  router.get('/api/admin/search-providers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listSearchProviders();
    json(res, 200, { 'search-providers': items });
  });

  router.get('/api/admin/search-providers/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getSearchProvider(params['id']!);
    if (!c) { json(res, 404, { error: 'Search provider not found' }); return; }
    json(res, 200, { 'search-provider': c });
  });

  router.post('/api/admin/search-providers', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['provider_type']) { json(res, 400, { error: 'name and provider_type required' }); return; }
    const id = randomUUID();
    await db.createSearchProvider({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      provider_type: body['provider_type'] as string,
      api_key: (body['api_key'] as string) ?? null,
      base_url: (body['base_url'] as string) ?? null,
      priority: (body['priority'] as number) ?? 0,
      options: body['options'] ? (typeof body['options'] === 'string' ? body['options'] as string : JSON.stringify(body['options'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getSearchProvider(id);
    json(res, 201, { 'search-provider': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/search-providers/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getSearchProvider(params['id']!);
    if (!existing) { json(res, 404, { error: 'Search provider not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['provider_type'] !== undefined) fields['provider_type'] = body['provider_type'];
    if (body['api_key'] !== undefined) fields['api_key'] = body['api_key'];
    if (body['base_url'] !== undefined) fields['base_url'] = body['base_url'];
    if (body['priority'] !== undefined) fields['priority'] = body['priority'];
    if (body['options'] !== undefined) fields['options'] = typeof body['options'] === 'string' ? body['options'] : JSON.stringify(body['options']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateSearchProvider(params['id']!, fields as any);
    const item = await db.getSearchProvider(params['id']!);
    json(res, 200, { 'search-provider': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/search-providers/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSearchProvider(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: HTTP Endpoints ──────────────────────────────────

  router.get('/api/admin/http-endpoints', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listHttpEndpoints();
    json(res, 200, { 'http-endpoints': items });
  });

  router.get('/api/admin/http-endpoints/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getHttpEndpoint(params['id']!);
    if (!c) { json(res, 404, { error: 'HTTP endpoint not found' }); return; }
    json(res, 200, { 'http-endpoint': c });
  });

  router.post('/api/admin/http-endpoints', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['url']) { json(res, 400, { error: 'name and url required' }); return; }
    const id = randomUUID();
    await db.createHttpEndpoint({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      url: body['url'] as string, method: (body['method'] as string) ?? 'GET',
      auth_type: (body['auth_type'] as string) ?? null,
      auth_config: body['auth_config'] ? (typeof body['auth_config'] === 'string' ? body['auth_config'] as string : JSON.stringify(body['auth_config'])) : null,
      headers: body['headers'] ? (typeof body['headers'] === 'string' ? body['headers'] as string : JSON.stringify(body['headers'])) : null,
      body_template: (body['body_template'] as string) ?? null,
      response_transform: (body['response_transform'] as string) ?? null,
      retry_count: (body['retry_count'] as number) ?? 2,
      rate_limit_rpm: (body['rate_limit_rpm'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getHttpEndpoint(id);
    json(res, 201, { 'http-endpoint': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/http-endpoints/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getHttpEndpoint(params['id']!);
    if (!existing) { json(res, 404, { error: 'HTTP endpoint not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['url'] !== undefined) fields['url'] = body['url'];
    if (body['method'] !== undefined) fields['method'] = body['method'];
    if (body['auth_type'] !== undefined) fields['auth_type'] = body['auth_type'];
    if (body['auth_config'] !== undefined) fields['auth_config'] = typeof body['auth_config'] === 'string' ? body['auth_config'] : JSON.stringify(body['auth_config']);
    if (body['headers'] !== undefined) fields['headers'] = typeof body['headers'] === 'string' ? body['headers'] : JSON.stringify(body['headers']);
    if (body['body_template'] !== undefined) fields['body_template'] = body['body_template'];
    if (body['response_transform'] !== undefined) fields['response_transform'] = body['response_transform'];
    if (body['retry_count'] !== undefined) fields['retry_count'] = body['retry_count'];
    if (body['rate_limit_rpm'] !== undefined) fields['rate_limit_rpm'] = body['rate_limit_rpm'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateHttpEndpoint(params['id']!, fields as any);
    const item = await db.getHttpEndpoint(params['id']!);
    json(res, 200, { 'http-endpoint': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/http-endpoints/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteHttpEndpoint(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Social Accounts ─────────────────────────────────

  router.get('/api/admin/social-accounts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listSocialAccounts();
    json(res, 200, { 'social-accounts': items });
  });

  router.get('/api/admin/social-accounts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getSocialAccount(params['id']!);
    if (!c) { json(res, 404, { error: 'Social account not found' }); return; }
    json(res, 200, { 'social-account': c });
  });

  router.post('/api/admin/social-accounts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['platform']) { json(res, 400, { error: 'name and platform required' }); return; }
    const id = randomUUID();
    await db.createSocialAccount({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      platform: body['platform'] as string,
      api_key: (body['api_key'] as string) ?? null,
      api_secret: (body['api_secret'] as string) ?? null,
      access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
      base_url: (body['base_url'] as string) ?? null,
      options: body['options'] ? (typeof body['options'] === 'string' ? body['options'] as string : JSON.stringify(body['options'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getSocialAccount(id);
    json(res, 201, { 'social-account': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/social-accounts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getSocialAccount(params['id']!);
    if (!existing) { json(res, 404, { error: 'Social account not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['platform'] !== undefined) fields['platform'] = body['platform'];
    if (body['api_key'] !== undefined) fields['api_key'] = body['api_key'];
    if (body['api_secret'] !== undefined) fields['api_secret'] = body['api_secret'];
    if (body['base_url'] !== undefined) fields['base_url'] = body['base_url'];
    if (body['options'] !== undefined) fields['options'] = typeof body['options'] === 'string' ? body['options'] : JSON.stringify(body['options']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateSocialAccount(params['id']!, fields as any);
    const item = await db.getSocialAccount(params['id']!);
    json(res, 200, { 'social-account': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/social-accounts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSocialAccount(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Enterprise Connectors ───────────────────────────

  router.get('/api/admin/enterprise-connectors', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listEnterpriseConnectors();
    json(res, 200, { 'enterprise-connectors': items });
  });

  router.get('/api/admin/enterprise-connectors/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getEnterpriseConnector(params['id']!);
    if (!c) { json(res, 404, { error: 'Enterprise connector not found' }); return; }
    json(res, 200, { 'enterprise-connector': c });
  });

  router.post('/api/admin/enterprise-connectors', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['connector_type']) { json(res, 400, { error: 'name and connector_type required' }); return; }
    const id = randomUUID();
    await db.createEnterpriseConnector({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      connector_type: body['connector_type'] as string,
      base_url: (body['base_url'] as string) ?? null,
      auth_type: (body['auth_type'] as string) ?? null,
      auth_config: body['auth_config'] ? (typeof body['auth_config'] === 'string' ? body['auth_config'] as string : JSON.stringify(body['auth_config'])) : null,
      access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
      options: body['options'] ? (typeof body['options'] === 'string' ? body['options'] as string : JSON.stringify(body['options'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getEnterpriseConnector(id);
    json(res, 201, { 'enterprise-connector': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/enterprise-connectors/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getEnterpriseConnector(params['id']!);
    if (!existing) { json(res, 404, { error: 'Enterprise connector not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['connector_type'] !== undefined) fields['connector_type'] = body['connector_type'];
    if (body['base_url'] !== undefined) fields['base_url'] = body['base_url'];
    if (body['auth_type'] !== undefined) fields['auth_type'] = body['auth_type'];
    if (body['auth_config'] !== undefined) fields['auth_config'] = typeof body['auth_config'] === 'string' ? body['auth_config'] : JSON.stringify(body['auth_config']);
    if (body['options'] !== undefined) fields['options'] = typeof body['options'] === 'string' ? body['options'] : JSON.stringify(body['options']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['access_token'] !== undefined) fields['access_token'] = body['access_token'];
    if (body['refresh_token'] !== undefined) fields['refresh_token'] = body['refresh_token'];
    if (body['token_expires_at'] !== undefined) fields['token_expires_at'] = body['token_expires_at'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    await db.updateEnterpriseConnector(params['id']!, fields as any);
    const item = await db.getEnterpriseConnector(params['id']!);
    json(res, 200, { 'enterprise-connector': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/enterprise-connectors/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteEnterpriseConnector(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Tool Registry ───────────────────────────────────

  router.get('/api/admin/tool-registry', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listToolRegistry();
    json(res, 200, { 'tool-registry': items });
  });

  router.get('/api/admin/tool-registry/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getToolRegistryEntry(params['id']!);
    if (!c) { json(res, 404, { error: 'Tool registry entry not found' }); return; }
    json(res, 200, { 'tool-registry-entry': c });
  });

  router.post('/api/admin/tool-registry', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['package_name']) { json(res, 400, { error: 'name and package_name required' }); return; }
    const id = randomUUID();
    await db.createToolRegistryEntry({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      package_name: body['package_name'] as string, version: (body['version'] as string) ?? '1.0.0',
      category: (body['category'] as string) ?? 'custom', risk_level: (body['risk_level'] as string) ?? 'low',
      tags: body['tags'] ? (typeof body['tags'] === 'string' ? body['tags'] as string : JSON.stringify(body['tags'])) : null,
      config: body['config'] ? (typeof body['config'] === 'string' ? body['config'] as string : JSON.stringify(body['config'])) : null,
      requires_approval: body['requires_approval'] ? 1 : 0,
      max_execution_ms: (body['max_execution_ms'] as number) ?? null,
      rate_limit_per_min: (body['rate_limit_per_min'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getToolRegistryEntry(id);
    json(res, 201, { 'tool-registry-entry': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/tool-registry/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolRegistryEntry(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tool registry entry not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['package_name'] !== undefined) fields['package_name'] = body['package_name'];
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['risk_level'] !== undefined) fields['risk_level'] = body['risk_level'];
    if (body['tags'] !== undefined) fields['tags'] = typeof body['tags'] === 'string' ? body['tags'] : JSON.stringify(body['tags']);
    if (body['config'] !== undefined) fields['config'] = typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']);
    if (body['requires_approval'] !== undefined) fields['requires_approval'] = body['requires_approval'] ? 1 : 0;
    if (body['max_execution_ms'] !== undefined) fields['max_execution_ms'] = body['max_execution_ms'];
    if (body['rate_limit_per_min'] !== undefined) fields['rate_limit_per_min'] = body['rate_limit_per_min'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateToolRegistryEntry(params['id']!, fields as any);
    const item = await db.getToolRegistryEntry(params['id']!);
    json(res, 200, { 'tool-registry-entry': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/tool-registry/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteToolRegistryEntry(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Replay Scenarios ─────────────────────────────────

  router.get('/api/admin/replay-scenarios', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listReplayScenarios();
    json(res, 200, { 'replay-scenarios': items });
  });

  router.get('/api/admin/replay-scenarios/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getReplayScenario(params['id']!);
    if (!c) { json(res, 404, { error: 'Replay scenario not found' }); return; }
    json(res, 200, { 'replay-scenario': c });
  });

  router.post('/api/admin/replay-scenarios', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['golden_prompt'] || !body['golden_response']) { json(res, 400, { error: 'name, golden_prompt and golden_response required' }); return; }
    const id = randomUUID();
    await db.createReplayScenario({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      golden_prompt: body['golden_prompt'] as string, golden_response: body['golden_response'] as string,
      model: (body['model'] as string) ?? null, provider: (body['provider'] as string) ?? null,
      tags: body['tags'] ? (typeof body['tags'] === 'string' ? body['tags'] as string : JSON.stringify(body['tags'])) : null,
      acceptance_criteria: body['acceptance_criteria'] ? (typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] as string : JSON.stringify(body['acceptance_criteria'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getReplayScenario(id);
    json(res, 201, { 'replay-scenario': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/replay-scenarios/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getReplayScenario(params['id']!);
    if (!existing) { json(res, 404, { error: 'Replay scenario not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['golden_prompt'] !== undefined) fields['golden_prompt'] = body['golden_prompt'];
    if (body['golden_response'] !== undefined) fields['golden_response'] = body['golden_response'];
    if (body['model'] !== undefined) fields['model'] = body['model'];
    if (body['provider'] !== undefined) fields['provider'] = body['provider'];
    if (body['tags'] !== undefined) fields['tags'] = typeof body['tags'] === 'string' ? body['tags'] : JSON.stringify(body['tags']);
    if (body['acceptance_criteria'] !== undefined) fields['acceptance_criteria'] = typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] : JSON.stringify(body['acceptance_criteria']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateReplayScenario(params['id']!, fields as any);
    const item = await db.getReplayScenario(params['id']!);
    json(res, 200, { 'replay-scenario': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/replay-scenarios/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteReplayScenario(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Trigger Definitions ────────────────────────────

  router.get('/api/admin/trigger-definitions', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listTriggerDefinitions();
    json(res, 200, { 'trigger-definitions': items });
  });

  router.get('/api/admin/trigger-definitions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getTriggerDefinition(params['id']!);
    if (!c) { json(res, 404, { error: 'Trigger definition not found' }); return; }
    json(res, 200, { 'trigger-definition': c });
  });

  router.post('/api/admin/trigger-definitions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['trigger_type']) { json(res, 400, { error: 'name and trigger_type required' }); return; }
    const id = randomUUID();
    await db.createTriggerDefinition({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      trigger_type: body['trigger_type'] as string,
      expression: (body['expression'] as string) ?? null,
      config: body['config'] ? (typeof body['config'] === 'string' ? body['config'] as string : JSON.stringify(body['config'])) : null,
      target_workflow: (body['target_workflow'] as string) ?? null,
      status: (body['status'] as string) ?? 'active',
      last_fired_at: null, fire_count: 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getTriggerDefinition(id);
    json(res, 201, { 'trigger-definition': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/trigger-definitions/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getTriggerDefinition(params['id']!);
    if (!existing) { json(res, 404, { error: 'Trigger definition not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['trigger_type'] !== undefined) fields['trigger_type'] = body['trigger_type'];
    if (body['expression'] !== undefined) fields['expression'] = body['expression'];
    if (body['config'] !== undefined) fields['config'] = typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']);
    if (body['target_workflow'] !== undefined) fields['target_workflow'] = body['target_workflow'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateTriggerDefinition(params['id']!, fields as any);
    const item = await db.getTriggerDefinition(params['id']!);
    json(res, 200, { 'trigger-definition': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/trigger-definitions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteTriggerDefinition(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Tenant Configs ─────────────────────────────────

  router.get('/api/admin/tenant-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listTenantConfigs();
    json(res, 200, { 'tenant-configs': items });
  });

  router.get('/api/admin/tenant-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getTenantConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Tenant config not found' }); return; }
    json(res, 200, { 'tenant-config': c });
  });

  router.post('/api/admin/tenant-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['tenant_id']) { json(res, 400, { error: 'name and tenant_id required' }); return; }
    const id = randomUUID();
    await db.createTenantConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      tenant_id: body['tenant_id'] as string,
      scope: (body['scope'] as string) ?? 'tenant',
      allowed_models: body['allowed_models'] ? (typeof body['allowed_models'] === 'string' ? body['allowed_models'] as string : JSON.stringify(body['allowed_models'])) : null,
      denied_models: body['denied_models'] ? (typeof body['denied_models'] === 'string' ? body['denied_models'] as string : JSON.stringify(body['denied_models'])) : null,
      allowed_tools: body['allowed_tools'] ? (typeof body['allowed_tools'] === 'string' ? body['allowed_tools'] as string : JSON.stringify(body['allowed_tools'])) : null,
      max_tokens_daily: (body['max_tokens_daily'] as number) ?? null,
      max_cost_daily: (body['max_cost_daily'] as number) ?? null,
      max_tokens_monthly: (body['max_tokens_monthly'] as number) ?? null,
      max_cost_monthly: (body['max_cost_monthly'] as number) ?? null,
      features: body['features'] ? (typeof body['features'] === 'string' ? body['features'] as string : JSON.stringify(body['features'])) : null,
      config_overrides: body['config_overrides'] ? (typeof body['config_overrides'] === 'string' ? body['config_overrides'] as string : JSON.stringify(body['config_overrides'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getTenantConfig(id);
    json(res, 201, { 'tenant-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/tenant-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getTenantConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tenant config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['tenant_id'] !== undefined) fields['tenant_id'] = body['tenant_id'];
    if (body['scope'] !== undefined) fields['scope'] = body['scope'];
    if (body['allowed_models'] !== undefined) fields['allowed_models'] = typeof body['allowed_models'] === 'string' ? body['allowed_models'] : JSON.stringify(body['allowed_models']);
    if (body['denied_models'] !== undefined) fields['denied_models'] = typeof body['denied_models'] === 'string' ? body['denied_models'] : JSON.stringify(body['denied_models']);
    if (body['allowed_tools'] !== undefined) fields['allowed_tools'] = typeof body['allowed_tools'] === 'string' ? body['allowed_tools'] : JSON.stringify(body['allowed_tools']);
    if (body['max_tokens_daily'] !== undefined) fields['max_tokens_daily'] = body['max_tokens_daily'];
    if (body['max_cost_daily'] !== undefined) fields['max_cost_daily'] = body['max_cost_daily'];
    if (body['max_tokens_monthly'] !== undefined) fields['max_tokens_monthly'] = body['max_tokens_monthly'];
    if (body['max_cost_monthly'] !== undefined) fields['max_cost_monthly'] = body['max_cost_monthly'];
    if (body['features'] !== undefined) fields['features'] = typeof body['features'] === 'string' ? body['features'] : JSON.stringify(body['features']);
    if (body['config_overrides'] !== undefined) fields['config_overrides'] = typeof body['config_overrides'] === 'string' ? body['config_overrides'] : JSON.stringify(body['config_overrides']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateTenantConfig(params['id']!, fields as any);
    const item = await db.getTenantConfig(params['id']!);
    json(res, 200, { 'tenant-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/tenant-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteTenantConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Sandbox Policies ────────────────────────────────

  router.get('/api/admin/sandbox-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listSandboxPolicies();
    json(res, 200, { 'sandbox-policies': items });
  });

  router.get('/api/admin/sandbox-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getSandboxPolicy(params['id']!);
    if (!c) { json(res, 404, { error: 'Sandbox policy not found' }); return; }
    json(res, 200, { 'sandbox-policy': c });
  });

  router.post('/api/admin/sandbox-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createSandboxPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      max_cpu_ms: (body['max_cpu_ms'] as number) ?? null,
      max_memory_mb: (body['max_memory_mb'] as number) ?? null,
      max_duration_ms: (body['max_duration_ms'] as number) ?? 30000,
      max_output_bytes: (body['max_output_bytes'] as number) ?? null,
      allowed_modules: body['allowed_modules'] ? (typeof body['allowed_modules'] === 'string' ? body['allowed_modules'] as string : JSON.stringify(body['allowed_modules'])) : null,
      denied_modules: body['denied_modules'] ? (typeof body['denied_modules'] === 'string' ? body['denied_modules'] as string : JSON.stringify(body['denied_modules'])) : null,
      network_access: body['network_access'] ? 1 : 0,
      filesystem_access: (body['filesystem_access'] as string) ?? 'none',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getSandboxPolicy(id);
    json(res, 201, { 'sandbox-policy': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/sandbox-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getSandboxPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Sandbox policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['max_cpu_ms'] !== undefined) fields['max_cpu_ms'] = body['max_cpu_ms'];
    if (body['max_memory_mb'] !== undefined) fields['max_memory_mb'] = body['max_memory_mb'];
    if (body['max_duration_ms'] !== undefined) fields['max_duration_ms'] = body['max_duration_ms'];
    if (body['max_output_bytes'] !== undefined) fields['max_output_bytes'] = body['max_output_bytes'];
    if (body['allowed_modules'] !== undefined) fields['allowed_modules'] = typeof body['allowed_modules'] === 'string' ? body['allowed_modules'] : JSON.stringify(body['allowed_modules']);
    if (body['denied_modules'] !== undefined) fields['denied_modules'] = typeof body['denied_modules'] === 'string' ? body['denied_modules'] : JSON.stringify(body['denied_modules']);
    if (body['network_access'] !== undefined) fields['network_access'] = body['network_access'] ? 1 : 0;
    if (body['filesystem_access'] !== undefined) fields['filesystem_access'] = body['filesystem_access'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateSandboxPolicy(params['id']!, fields as any);
    const item = await db.getSandboxPolicy(params['id']!);
    json(res, 200, { 'sandbox-policy': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/sandbox-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSandboxPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Extraction Pipelines ────────────────────────────

  router.get('/api/admin/extraction-pipelines', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listExtractionPipelines();
    json(res, 200, { 'extraction-pipelines': items });
  });

  router.get('/api/admin/extraction-pipelines/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getExtractionPipeline(params['id']!);
    if (!c) { json(res, 404, { error: 'Extraction pipeline not found' }); return; }
    json(res, 200, { 'extraction-pipeline': c });
  });

  router.post('/api/admin/extraction-pipelines', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createExtractionPipeline({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      stages: body['stages'] ? (typeof body['stages'] === 'string' ? body['stages'] as string : JSON.stringify(body['stages'])) : '[]',
      input_mime_types: body['input_mime_types'] ? (typeof body['input_mime_types'] === 'string' ? body['input_mime_types'] as string : JSON.stringify(body['input_mime_types'])) : null,
      max_input_size_bytes: (body['max_input_size_bytes'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getExtractionPipeline(id);
    json(res, 201, { 'extraction-pipeline': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/extraction-pipelines/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getExtractionPipeline(params['id']!);
    if (!existing) { json(res, 404, { error: 'Extraction pipeline not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['stages'] !== undefined) fields['stages'] = typeof body['stages'] === 'string' ? body['stages'] : JSON.stringify(body['stages']);
    if (body['input_mime_types'] !== undefined) fields['input_mime_types'] = typeof body['input_mime_types'] === 'string' ? body['input_mime_types'] : JSON.stringify(body['input_mime_types']);
    if (body['max_input_size_bytes'] !== undefined) fields['max_input_size_bytes'] = body['max_input_size_bytes'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateExtractionPipeline(params['id']!, fields as any);
    const item = await db.getExtractionPipeline(params['id']!);
    json(res, 200, { 'extraction-pipeline': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/extraction-pipelines/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteExtractionPipeline(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Artifact Policies ───────────────────────────────

  router.get('/api/admin/artifact-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listArtifactPolicies();
    json(res, 200, { 'artifact-policies': items });
  });

  router.get('/api/admin/artifact-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getArtifactPolicy(params['id']!);
    if (!c) { json(res, 404, { error: 'Artifact policy not found' }); return; }
    json(res, 200, { 'artifact-policy': c });
  });

  router.post('/api/admin/artifact-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createArtifactPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      max_size_bytes: (body['max_size_bytes'] as number) ?? null,
      allowed_types: body['allowed_types'] ? (typeof body['allowed_types'] === 'string' ? body['allowed_types'] as string : JSON.stringify(body['allowed_types'])) : null,
      retention_days: (body['retention_days'] as number) ?? null,
      require_versioning: body['require_versioning'] ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getArtifactPolicy(id);
    json(res, 201, { 'artifact-policy': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/artifact-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getArtifactPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Artifact policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['max_size_bytes'] !== undefined) fields['max_size_bytes'] = body['max_size_bytes'];
    if (body['allowed_types'] !== undefined) fields['allowed_types'] = typeof body['allowed_types'] === 'string' ? body['allowed_types'] : JSON.stringify(body['allowed_types']);
    if (body['retention_days'] !== undefined) fields['retention_days'] = body['retention_days'];
    if (body['require_versioning'] !== undefined) fields['require_versioning'] = body['require_versioning'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateArtifactPolicy(params['id']!, fields as any);
    const item = await db.getArtifactPolicy(params['id']!);
    json(res, 200, { 'artifact-policy': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/artifact-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteArtifactPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Reliability Policies ────────────────────────────

  router.get('/api/admin/reliability-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listReliabilityPolicies();
    json(res, 200, { 'reliability-policies': items });
  });

  router.get('/api/admin/reliability-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getReliabilityPolicy(params['id']!);
    if (!c) { json(res, 404, { error: 'Reliability policy not found' }); return; }
    json(res, 200, { 'reliability-policy': c });
  });

  router.post('/api/admin/reliability-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createReliabilityPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      policy_type: (body['policy_type'] as string) ?? 'retry',
      max_retries: (body['max_retries'] as number) ?? null,
      initial_delay_ms: (body['initial_delay_ms'] as number) ?? null,
      max_delay_ms: (body['max_delay_ms'] as number) ?? null,
      backoff_multiplier: (body['backoff_multiplier'] as number) ?? null,
      max_concurrent: (body['max_concurrent'] as number) ?? null,
      queue_size: (body['queue_size'] as number) ?? null,
      strategy: (body['strategy'] as string) ?? null,
      ttl_ms: (body['ttl_ms'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getReliabilityPolicy(id);
    json(res, 201, { 'reliability-policy': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/reliability-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getReliabilityPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Reliability policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['policy_type'] !== undefined) fields['policy_type'] = body['policy_type'];
    if (body['max_retries'] !== undefined) fields['max_retries'] = body['max_retries'];
    if (body['initial_delay_ms'] !== undefined) fields['initial_delay_ms'] = body['initial_delay_ms'];
    if (body['max_delay_ms'] !== undefined) fields['max_delay_ms'] = body['max_delay_ms'];
    if (body['backoff_multiplier'] !== undefined) fields['backoff_multiplier'] = body['backoff_multiplier'];
    if (body['max_concurrent'] !== undefined) fields['max_concurrent'] = body['max_concurrent'];
    if (body['queue_size'] !== undefined) fields['queue_size'] = body['queue_size'];
    if (body['strategy'] !== undefined) fields['strategy'] = body['strategy'];
    if (body['ttl_ms'] !== undefined) fields['ttl_ms'] = body['ttl_ms'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateReliabilityPolicy(params['id']!, fields as any);
    const item = await db.getReliabilityPolicy(params['id']!);
    json(res, 200, { 'reliability-policy': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/reliability-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteReliabilityPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Collaboration Sessions ──────────────────────────

  router.get('/api/admin/collaboration-sessions', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listCollaborationSessions();
    json(res, 200, { 'collaboration-sessions': items });
  });

  router.get('/api/admin/collaboration-sessions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getCollaborationSession(params['id']!);
    if (!c) { json(res, 404, { error: 'Collaboration session not found' }); return; }
    json(res, 200, { 'collaboration-session': c });
  });

  router.post('/api/admin/collaboration-sessions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createCollaborationSession({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      session_type: (body['session_type'] as string) ?? 'team',
      max_participants: (body['max_participants'] as number) ?? 10,
      presence_ttl_ms: (body['presence_ttl_ms'] as number) ?? 30000,
      auto_close_idle_ms: (body['auto_close_idle_ms'] as number) ?? null,
      handoff_enabled: body['handoff_enabled'] !== false ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getCollaborationSession(id);
    json(res, 201, { 'collaboration-session': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/collaboration-sessions/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getCollaborationSession(params['id']!);
    if (!existing) { json(res, 404, { error: 'Collaboration session not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['session_type'] !== undefined) fields['session_type'] = body['session_type'];
    if (body['max_participants'] !== undefined) fields['max_participants'] = body['max_participants'];
    if (body['presence_ttl_ms'] !== undefined) fields['presence_ttl_ms'] = body['presence_ttl_ms'];
    if (body['auto_close_idle_ms'] !== undefined) fields['auto_close_idle_ms'] = body['auto_close_idle_ms'];
    if (body['handoff_enabled'] !== undefined) fields['handoff_enabled'] = body['handoff_enabled'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateCollaborationSession(params['id']!, fields as any);
    const item = await db.getCollaborationSession(params['id']!);
    json(res, 200, { 'collaboration-session': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/collaboration-sessions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteCollaborationSession(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Graph Configs ───────────────────────────────────

  router.get('/api/admin/graph-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listGraphConfigs();
    json(res, 200, { 'graph-configs': items });
  });

  router.get('/api/admin/graph-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getGraphConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Graph config not found' }); return; }
    json(res, 200, { 'graph-config': c });
  });

  router.post('/api/admin/graph-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createGraphConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      graph_type: (body['graph_type'] as string) ?? 'entity',
      max_depth: (body['max_depth'] as number) ?? 3,
      entity_types: body['entity_types'] != null ? (typeof body['entity_types'] === 'string' ? body['entity_types'] as string : JSON.stringify(body['entity_types'])) : null,
      relationship_types: body['relationship_types'] != null ? (typeof body['relationship_types'] === 'string' ? body['relationship_types'] as string : JSON.stringify(body['relationship_types'])) : null,
      auto_link: body['auto_link'] !== false ? 1 : 0,
      scoring_weights: body['scoring_weights'] != null ? (typeof body['scoring_weights'] === 'string' ? body['scoring_weights'] as string : JSON.stringify(body['scoring_weights'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getGraphConfig(id);
    json(res, 201, { 'graph-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/graph-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getGraphConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Graph config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['graph_type'] !== undefined) fields['graph_type'] = body['graph_type'];
    if (body['max_depth'] !== undefined) fields['max_depth'] = body['max_depth'];
    if (body['entity_types'] !== undefined) fields['entity_types'] = body['entity_types'] != null ? (typeof body['entity_types'] === 'string' ? body['entity_types'] : JSON.stringify(body['entity_types'])) : null;
    if (body['relationship_types'] !== undefined) fields['relationship_types'] = body['relationship_types'] != null ? (typeof body['relationship_types'] === 'string' ? body['relationship_types'] : JSON.stringify(body['relationship_types'])) : null;
    if (body['auto_link'] !== undefined) fields['auto_link'] = body['auto_link'] ? 1 : 0;
    if (body['scoring_weights'] !== undefined) fields['scoring_weights'] = body['scoring_weights'] != null ? (typeof body['scoring_weights'] === 'string' ? body['scoring_weights'] : JSON.stringify(body['scoring_weights'])) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateGraphConfig(params['id']!, fields as any);
    const item = await db.getGraphConfig(params['id']!);
    json(res, 200, { 'graph-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/graph-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteGraphConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Plugin Configs ──────────────────────────────────

  router.get('/api/admin/plugin-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listPluginConfigs();
    json(res, 200, { 'plugin-configs': items });
  });

  router.get('/api/admin/plugin-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getPluginConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Plugin config not found' }); return; }
    json(res, 200, { 'plugin-config': c });
  });

  router.post('/api/admin/plugin-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createPluginConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      plugin_type: (body['plugin_type'] as string) ?? 'community',
      package_name: (body['package_name'] as string) ?? 'unknown',
      version: (body['version'] as string) ?? '1.0.0',
      capabilities: body['capabilities'] != null ? (typeof body['capabilities'] === 'string' ? body['capabilities'] as string : JSON.stringify(body['capabilities'])) : null,
      trust_level: (body['trust_level'] as string) ?? 'community',
      auto_update: body['auto_update'] ? 1 : 0,
      config: body['config'] != null ? (typeof body['config'] === 'string' ? body['config'] as string : JSON.stringify(body['config'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getPluginConfig(id);
    json(res, 201, { 'plugin-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/plugin-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPluginConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Plugin config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['plugin_type'] !== undefined) fields['plugin_type'] = body['plugin_type'];
    if (body['package_name'] !== undefined) fields['package_name'] = body['package_name'];
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['capabilities'] !== undefined) fields['capabilities'] = body['capabilities'] != null ? (typeof body['capabilities'] === 'string' ? body['capabilities'] : JSON.stringify(body['capabilities'])) : null;
    if (body['trust_level'] !== undefined) fields['trust_level'] = body['trust_level'];
    if (body['auto_update'] !== undefined) fields['auto_update'] = body['auto_update'] ? 1 : 0;
    if (body['config'] !== undefined) fields['config'] = body['config'] != null ? (typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config'])) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePluginConfig(params['id']!, fields as any);
    const item = await db.getPluginConfig(params['id']!);
    json(res, 200, { 'plugin-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/plugin-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePluginConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Scaffold Templates ────────────────────────────────

  router.get('/api/admin/scaffold-templates', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listScaffoldTemplates();
    json(res, 200, { 'scaffold-templates': items });
  });

  router.get('/api/admin/scaffold-templates/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getScaffoldTemplate(params['id']!);
    if (!c) { json(res, 404, { error: 'Scaffold template not found' }); return; }
    json(res, 200, { 'scaffold-template': c });
  });

  router.post('/api/admin/scaffold-templates', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createScaffoldTemplate({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      template_type: (body['template_type'] as string) ?? 'basic-agent',
      files: body['files'] != null ? (typeof body['files'] === 'string' ? body['files'] as string : JSON.stringify(body['files'])) : null,
      dependencies: body['dependencies'] != null ? (typeof body['dependencies'] === 'string' ? body['dependencies'] as string : JSON.stringify(body['dependencies'])) : null,
      dev_dependencies: body['dev_dependencies'] != null ? (typeof body['dev_dependencies'] === 'string' ? body['dev_dependencies'] as string : JSON.stringify(body['dev_dependencies'])) : null,
      variables: body['variables'] != null ? (typeof body['variables'] === 'string' ? body['variables'] as string : JSON.stringify(body['variables'])) : null,
      post_install: (body['post_install'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getScaffoldTemplate(id);
    json(res, 201, { 'scaffold-template': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/scaffold-templates/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getScaffoldTemplate(params['id']!);
    if (!existing) { json(res, 404, { error: 'Scaffold template not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['template_type'] !== undefined) fields['template_type'] = body['template_type'];
    if (body['files'] !== undefined) fields['files'] = body['files'] != null ? (typeof body['files'] === 'string' ? body['files'] : JSON.stringify(body['files'])) : null;
    if (body['dependencies'] !== undefined) fields['dependencies'] = body['dependencies'] != null ? (typeof body['dependencies'] === 'string' ? body['dependencies'] : JSON.stringify(body['dependencies'])) : null;
    if (body['dev_dependencies'] !== undefined) fields['dev_dependencies'] = body['dev_dependencies'] != null ? (typeof body['dev_dependencies'] === 'string' ? body['dev_dependencies'] : JSON.stringify(body['dev_dependencies'])) : null;
    if (body['variables'] !== undefined) fields['variables'] = body['variables'] != null ? (typeof body['variables'] === 'string' ? body['variables'] : JSON.stringify(body['variables'])) : null;
    if (body['post_install'] !== undefined) fields['post_install'] = body['post_install'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateScaffoldTemplate(params['id']!, fields as any);
    const item = await db.getScaffoldTemplate(params['id']!);
    json(res, 200, { 'scaffold-template': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/scaffold-templates/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteScaffoldTemplate(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Recipe Configs ──────────────────────────────────

  router.get('/api/admin/recipe-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listRecipeConfigs();
    json(res, 200, { 'recipe-configs': items });
  });

  router.get('/api/admin/recipe-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getRecipeConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Recipe config not found' }); return; }
    json(res, 200, { 'recipe-config': c });
  });

  router.post('/api/admin/recipe-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createRecipeConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      recipe_type: (body['recipe_type'] as string) ?? 'workflow',
      model: (body['model'] as string) ?? null,
      provider: (body['provider'] as string) ?? null,
      system_prompt: (body['system_prompt'] as string) ?? null,
      tools: body['tools'] != null ? (typeof body['tools'] === 'string' ? body['tools'] as string : JSON.stringify(body['tools'])) : null,
      guardrails: body['guardrails'] != null ? (typeof body['guardrails'] === 'string' ? body['guardrails'] as string : JSON.stringify(body['guardrails'])) : null,
      max_steps: body['max_steps'] != null ? Number(body['max_steps']) : 10,
      options: body['options'] != null ? (typeof body['options'] === 'string' ? body['options'] as string : JSON.stringify(body['options'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getRecipeConfig(id);
    json(res, 201, { 'recipe-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/recipe-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getRecipeConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Recipe config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['recipe_type'] !== undefined) fields['recipe_type'] = body['recipe_type'];
    if (body['model'] !== undefined) fields['model'] = body['model'];
    if (body['provider'] !== undefined) fields['provider'] = body['provider'];
    if (body['system_prompt'] !== undefined) fields['system_prompt'] = body['system_prompt'];
    if (body['tools'] !== undefined) fields['tools'] = body['tools'] != null ? (typeof body['tools'] === 'string' ? body['tools'] : JSON.stringify(body['tools'])) : null;
    if (body['guardrails'] !== undefined) fields['guardrails'] = body['guardrails'] != null ? (typeof body['guardrails'] === 'string' ? body['guardrails'] : JSON.stringify(body['guardrails'])) : null;
    if (body['max_steps'] !== undefined) fields['max_steps'] = Number(body['max_steps']);
    if (body['options'] !== undefined) fields['options'] = body['options'] != null ? (typeof body['options'] === 'string' ? body['options'] : JSON.stringify(body['options'])) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateRecipeConfig(params['id']!, fields as any);
    const item = await db.getRecipeConfig(params['id']!);
    json(res, 200, { 'recipe-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/recipe-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteRecipeConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Widget Configs ──────────────────────────────────

  router.get('/api/admin/widget-configs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listWidgetConfigs();
    json(res, 200, { 'widget-configs': items });
  });

  router.get('/api/admin/widget-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getWidgetConfig(params['id']!);
    if (!c) { json(res, 404, { error: 'Widget config not found' }); return; }
    json(res, 200, { 'widget-config': c });
  });

  router.post('/api/admin/widget-configs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createWidgetConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      widget_type: (body['widget_type'] as string) ?? 'table',
      default_options: body['default_options'] != null ? (typeof body['default_options'] === 'string' ? body['default_options'] as string : JSON.stringify(body['default_options'])) : null,
      allowed_contexts: body['allowed_contexts'] != null ? (typeof body['allowed_contexts'] === 'string' ? body['allowed_contexts'] as string : JSON.stringify(body['allowed_contexts'])) : null,
      max_data_points: body['max_data_points'] != null ? Number(body['max_data_points']) : null,
      refresh_interval_ms: body['refresh_interval_ms'] != null ? Number(body['refresh_interval_ms']) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getWidgetConfig(id);
    json(res, 201, { 'widget-config': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/widget-configs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getWidgetConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Widget config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['widget_type'] !== undefined) fields['widget_type'] = body['widget_type'];
    if (body['default_options'] !== undefined) fields['default_options'] = body['default_options'] != null ? (typeof body['default_options'] === 'string' ? body['default_options'] : JSON.stringify(body['default_options'])) : null;
    if (body['allowed_contexts'] !== undefined) fields['allowed_contexts'] = body['allowed_contexts'] != null ? (typeof body['allowed_contexts'] === 'string' ? body['allowed_contexts'] : JSON.stringify(body['allowed_contexts'])) : null;
    if (body['max_data_points'] !== undefined) fields['max_data_points'] = body['max_data_points'] != null ? Number(body['max_data_points']) : null;
    if (body['refresh_interval_ms'] !== undefined) fields['refresh_interval_ms'] = body['refresh_interval_ms'] != null ? Number(body['refresh_interval_ms']) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateWidgetConfig(params['id']!, fields as any);
    const item = await db.getWidgetConfig(params['id']!);
    json(res, 200, { 'widget-config': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/widget-configs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWidgetConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Validation Rules ────────────────────────────────

  router.get('/api/admin/validation-rules', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listValidationRules();
    json(res, 200, { 'validation-rules': items });
  });

  router.get('/api/admin/validation-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getValidationRule(params['id']!);
    if (!c) { json(res, 404, { error: 'Validation rule not found' }); return; }
    json(res, 200, { 'validation-rule': c });
  });

  router.post('/api/admin/validation-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = randomUUID();
    await db.createValidationRule({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      rule_type: (body['rule_type'] as string) ?? 'required',
      target: (body['target'] as string) ?? 'agent-config',
      condition: body['condition'] != null ? (typeof body['condition'] === 'string' ? body['condition'] as string : JSON.stringify(body['condition'])) : null,
      severity: (body['severity'] as string) ?? 'error',
      message: (body['message'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getValidationRule(id);
    json(res, 201, { 'validation-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/validation-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getValidationRule(params['id']!);
    if (!existing) { json(res, 404, { error: 'Validation rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['rule_type'] !== undefined) fields['rule_type'] = body['rule_type'];
    if (body['target'] !== undefined) fields['target'] = body['target'];
    if (body['condition'] !== undefined) fields['condition'] = body['condition'] != null ? (typeof body['condition'] === 'string' ? body['condition'] : JSON.stringify(body['condition'])) : null;
    if (body['severity'] !== undefined) fields['severity'] = body['severity'];
    if (body['message'] !== undefined) fields['message'] = body['message'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateValidationRule(params['id']!, fields as any);
    const item = await db.getValidationRule(params['id']!);
    json(res, 200, { 'validation-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/validation-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteValidationRule(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Seed data ───────────────────────────────────────

  router.post('/api/admin/seed', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.seedDefaultData();
    json(res, 200, { ok: true, message: 'Default data seeded' });
  }, { auth: true, csrf: true });

  // ── Admin: Version / About ────────────────────────────────

  const FABRIC_CODENAMES = [
    'Aertex','Batiste','Calico','Damask','Etamine','Flannel','Gauze',
    'Habutai','Intarsia','Jersey','Knit','Linen','Muslin','Nankeen',
    'Organza','Percale','Rinzu','Satin','Taffeta','Ultrasuede',
    'Velvet','Wadmal','Zephyr',
  ];

  function fabricForMajor(major: number): string {
    return FABRIC_CODENAMES[major - 1] ?? `v${major}`;
  }

  const CURRENT_VERSION = '1.0.0';

  router.get('/api/admin/version', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const currentMajor = parseInt(CURRENT_VERSION.split('.')[0]!, 10);
    const result: Record<string, unknown> = {
      currentVersion: CURRENT_VERSION,
      codename: fabricForMajor(currentMajor),
      repoUrl: 'https://github.com/gibyvarghese/weaveintel',
    };

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(
        'https://api.github.com/repos/gibyvarghese/weaveintel/releases/latest',
        {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'geneweave' },
          signal: ctrl.signal,
        },
      );
      clearTimeout(timer);
      if (resp.ok) {
        const data = (await resp.json()) as { tag_name?: string; html_url?: string };
        const tag = (data.tag_name ?? '').replace(/^v/, '');
        if (tag) {
          const latestMajor = parseInt(tag.split('.')[0]!, 10);
          result['latestVersion'] = tag;
          result['latestCodename'] = fabricForMajor(latestMajor);
          result['updateAvailable'] = tag !== CURRENT_VERSION;
          result['releaseUrl'] = data.html_url ?? null;
        }
      }
    } catch {
      /* GitHub unreachable — just return current info */
    }

    json(res, 200, result);
  });

  router.post('/api/admin/upgrade', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if ((process.env['GENEWEAVE_ALLOW_ADMIN_UPGRADE'] ?? '').toLowerCase() !== 'true') {
      json(res, 403, { error: 'Admin upgrade endpoint is disabled. Set GENEWEAVE_ALLOW_ADMIN_UPGRADE=true to enable.' });
      return;
    }

    const { execSync } = await import('node:child_process');
    const cwd = process.cwd();

    try {
      execSync('git pull origin main', { cwd, timeout: 60_000, stdio: 'pipe' });
      execSync('npm install', { cwd, timeout: 120_000, stdio: 'pipe' });
      execSync('npx turbo build', { cwd, timeout: 180_000, stdio: 'pipe' });
      json(res, 200, { ok: true, message: 'Upgrade complete. Restart the server to apply changes.' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: 'Upgrade failed', details: msg });
    }
  }, { auth: true, csrf: true });

  // ── Connector OAuth routes ─────────────────────────────────

  // OAuth config for each connector type
  const OAUTH_CONFIGS: Record<string, { authorizationUrl: string; tokenUrl: string; scopes: string[]; domainTemplate?: string }> = {
    jira: {
      authorizationUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'],
    },
    servicenow: {
      authorizationUrl: 'https://{{domain}}.service-now.com/oauth_auth.do',
      tokenUrl: 'https://{{domain}}.service-now.com/oauth_token.do',
      scopes: ['useraccount'],
      domainTemplate: '{{domain}}.service-now.com',
    },
    facebook: {
      authorizationUrl: 'https://www.facebook.com/v25.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v25.0/oauth/access_token',
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content'],
    },
    instagram: {
      authorizationUrl: 'https://www.facebook.com/v25.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v25.0/oauth/access_token',
      scopes: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments'],
    },
    canva: {
      authorizationUrl: 'https://www.canva.com/api/oauth/authorize',
      tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
      scopes: ['design:content:read', 'design:content:write', 'design:meta:read', 'asset:read', 'asset:write'],
    },
  };

  // GET /api/connectors — list all connectors (enterprise + social combined)
  router.get('/api/connectors', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const [enterprise, social] = await Promise.all([db.listEnterpriseConnectors(), db.listSocialAccounts()]);
    json(res, 200, { enterprise, social });
  });

  // GET /api/connectors/:type/authorize — build OAuth authorization URL
  router.get('/api/connectors/:type/authorize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const connectorType = params['type']!;
    const oauthCfg = OAUTH_CONFIGS[connectorType];
    if (!oauthCfg) { json(res, 400, { error: `Unknown connector type: ${connectorType}` }); return; }

    const url = new URL(req.url!, `http://${req.headers.host}`);
    const connectorId = url.searchParams.get('connector_id');
    const domain = url.searchParams.get('domain') || '';

    // Client ID from env: e.g. JIRA_CLIENT_ID, FACEBOOK_CLIENT_ID
    const envPrefix = connectorType.toUpperCase();
    const clientId = process.env[`${envPrefix}_CLIENT_ID`];
    if (!clientId) { json(res, 400, { error: `${envPrefix}_CLIENT_ID not configured in environment` }); return; }

    // Generate CSRF state
    const oauthState = randomUUID();

    // Store state in connector record (if connector_id provided) for callback validation
    if (connectorId) {
      const isSocial = ['facebook', 'instagram'].includes(connectorType);
      if (isSocial) {
        await db.updateSocialAccount(connectorId, { oauth_state: oauthState });
      } else {
        await db.updateEnterpriseConnector(connectorId, { oauth_state: oauthState });
      }
    }

    // Build authorization URL
    let authUrl = oauthCfg.authorizationUrl.replace('{{domain}}', domain);
    const redirectUri = `${url.protocol}//${url.host}/api/connectors/callback`;
    const authParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: oauthCfg.scopes.join(' '),
      state: `${connectorType}:${connectorId || 'new'}:${oauthState}`,
    });
    // Jira/Atlassian needs audience and prompt params
    if (connectorType === 'jira') {
      authParams.set('audience', 'api.atlassian.com');
      authParams.set('prompt', 'consent');
    }

    json(res, 200, { url: `${authUrl}?${authParams.toString()}` });
  });

  // GET /api/connectors/callback — OAuth redirect callback
  router.get('/api/connectors/callback', async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      htmlResp(res, 200, `<html><body><script>window.opener.postMessage({type:'oauth-error',error:'${error.replace(/'/g, "\\'")}'}, window.location.origin);window.close();</script></body></html>`);
      return;
    }

    if (!code || !stateParam) {
      htmlResp(res, 400, `<html><body><script>window.opener.postMessage({type:'oauth-error',error:'Missing code or state'}, window.location.origin);window.close();</script></body></html>`);
      return;
    }

    // Parse state: "type:connectorId:oauthState"
    const parts = stateParam.split(':');
    if (parts.length < 3) {
      htmlResp(res, 400, `<html><body><script>window.opener.postMessage({type:'oauth-error',error:'Invalid state'}, window.location.origin);window.close();</script></body></html>`);
      return;
    }
    const connectorType = parts[0]!;
    const connectorId = parts[1]!;
    const oauthState = parts.slice(2).join(':');

    const oauthCfg = OAUTH_CONFIGS[connectorType];
    if (!oauthCfg) {
      htmlResp(res, 400, `<html><body><script>window.opener.postMessage({type:'oauth-error',error:'Unknown connector type'}, window.location.origin);window.close();</script></body></html>`);
      return;
    }

    // Validate state against stored value
    const isSocial = ['facebook', 'instagram'].includes(connectorType);
    if (connectorId !== 'new') {
      const stored = isSocial
        ? await db.getSocialAccount(connectorId)
        : await db.getEnterpriseConnector(connectorId);
      if (!stored || stored.oauth_state !== oauthState) {
        htmlResp(res, 400, `<html><body><script>window.opener.postMessage({type:'oauth-error',error:'State mismatch — possible CSRF'}, window.location.origin);window.close();</script></body></html>`);
        return;
      }
    }

    // Exchange code for tokens
    const envPrefix = connectorType.toUpperCase();
    const clientId = process.env[`${envPrefix}_CLIENT_ID`] || '';
    const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`] || '';
    const redirectUri = `${url.protocol}//${url.host}/api/connectors/callback`;
    const domain = url.searchParams.get('domain') || '';
    const tokenUrl = oauthCfg.tokenUrl.replace('{{domain}}', domain);

    try {
      const tokenResp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        htmlResp(res, 200, `<html><body><script>window.opener.postMessage({type:'oauth-error',error:'Token exchange failed: ${tokenResp.status}'}, window.location.origin);window.close();</script></body></html>`);
        return;
      }

      const tokens = await tokenResp.json() as Record<string, unknown>;
      const accessToken = (tokens['access_token'] as string) || '';
      const refreshToken = (tokens['refresh_token'] as string) || null;
      const expiresIn = (tokens['expires_in'] as number) || 3600;
      const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

      // Update connector with tokens
      if (connectorId !== 'new') {
        if (isSocial) {
          await db.updateSocialAccount(connectorId, {
            access_token: accessToken,
            refresh_token: refreshToken,
            token_expires_at: tokenExpiresAt,
            oauth_state: null,
            status: 'connected',
          });
        } else {
          await db.updateEnterpriseConnector(connectorId, {
            access_token: accessToken,
            refresh_token: refreshToken,
            token_expires_at: tokenExpiresAt,
            oauth_state: null,
            status: 'connected',
            auth_type: 'oauth2',
          });
        }
      }

      htmlResp(res, 200, `<html><body><script>window.opener.postMessage({type:'oauth-success',connectorType:'${connectorType}',connectorId:'${connectorId}'}, window.location.origin);window.close();</script></body></html>`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      htmlResp(res, 200, `<html><body><script>window.opener.postMessage({type:'oauth-error',error:'${msg.replace(/'/g, "\\'")}'}, window.location.origin);window.close();</script></body></html>`);
    }
  }, { auth: false, csrf: false });

  // POST /api/connectors/:id/disconnect — clear tokens and disconnect
  router.post('/api/connectors/:id/disconnect', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const raw = await readBody(req);
    let body: { table?: string };
    try { body = JSON.parse(raw); } catch { body = {}; }
    const table = body.table || 'enterprise';

    if (table === 'social') {
      await db.updateSocialAccount(id, {
        access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
      });
    } else {
      await db.updateEnterpriseConnector(id, {
        access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
      });
    }
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // POST /api/connectors/:id/test — test a connection
  router.post('/api/connectors/:id/test', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const id = params['id']!;
    const raw = await readBody(req);
    let body: { table?: string };
    try { body = JSON.parse(raw); } catch { body = {}; }
    const table = body.table || 'enterprise';

    const connector = table === 'social'
      ? await db.getSocialAccount(id)
      : await db.getEnterpriseConnector(id);

    if (!connector) { json(res, 404, { error: 'Connector not found' }); return; }
    if (!('access_token' in connector) || !connector.access_token) {
      json(res, 400, { error: 'Connector not authenticated' }); return;
    }

    // Simple health check — test if token is valid by making a lightweight API call
    try {
      const type = table === 'social' ? (connector as any).platform : (connector as any).connector_type;
      const testUrls: Record<string, string> = {
        jira: 'https://api.atlassian.com/me',
        facebook: 'https://graph.facebook.com/v25.0/me',
        instagram: 'https://graph.facebook.com/v25.0/me',
        canva: 'https://api.canva.com/rest/v1/users/me',
        servicenow: connector.base_url ? `${connector.base_url}/api/now/table/sys_user?sysparm_limit=1` : '',
      };
      const testUrl = testUrls[type] || '';
      if (!testUrl) { json(res, 200, { ok: true, message: 'No test endpoint configured' }); return; }

      const testResp = await fetch(testUrl, {
        headers: { 'Authorization': `Bearer ${connector.access_token}`, 'Accept': 'application/json' },
      });

      if (testResp.ok) {
        json(res, 200, { ok: true, message: 'Connection verified' });
      } else {
        json(res, 200, { ok: false, message: `API returned ${testResp.status}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 200, { ok: false, message: msg });
    }
  }, { auth: true, csrf: true });

}
