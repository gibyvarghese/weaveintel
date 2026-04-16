/**
 * @weaveintel/geneweave — Admin CRUD routes
 *
 * Registers all admin configuration endpoints (prompts, guardrails, routing, etc.)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from './db.js';
import { syncModelPricing } from './pricing-sync.js';
import type { AuthContext } from './auth.js';

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
    const id = 'prompt-' + randomUUID().slice(0, 8);
    await db.createPrompt({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      category: (body['category'] as string) ?? null, template: body['template'] as string,
      variables: body['variables'] ? JSON.stringify(body['variables']) : null,
      version: (body['version'] as string) ?? '1.0', is_default: body['is_default'] ? 1 : 0, enabled: body['enabled'] !== false ? 1 : 0,
    });
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
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['template'] !== undefined) fields['template'] = body['template'];
    if (body['variables'] !== undefined) fields['variables'] = JSON.stringify(body['variables']);
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['is_default'] !== undefined) fields['is_default'] = body['is_default'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePrompt(params['id']!, fields as any);
    const prompt = await db.getPrompt(params['id']!);
    json(res, 200, { prompt });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePrompt(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Guardrails ──────────────────────────────────────

  router.get('/api/admin/guardrails', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const guardrails = await db.listGuardrails();
    json(res, 200, { guardrails });
  });

  router.get('/api/admin/guardrails/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const g = await db.getGuardrail(params['id']!);
    if (!g) { json(res, 404, { error: 'Guardrail not found' }); return; }
    json(res, 200, { guardrail: g });
  });

  router.post('/api/admin/guardrails', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['type']) { json(res, 400, { error: 'name and type required' }); return; }
    const id = 'guard-' + randomUUID().slice(0, 8);
    await db.createGuardrail({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      type: body['type'] as string, stage: (body['stage'] as string) ?? 'pre',
      config: body['config'] ? JSON.stringify(body['config']) : null,
      priority: (body['priority'] as number) ?? 0, enabled: body['enabled'] !== false ? 1 : 0,
    });
    const guardrail = await db.getGuardrail(id);
    json(res, 201, { guardrail });
  }, { auth: true, csrf: true });

  router.put('/api/admin/guardrails/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getGuardrail(params['id']!);
    if (!existing) { json(res, 404, { error: 'Guardrail not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['type'] !== undefined) fields['type'] = body['type'];
    if (body['stage'] !== undefined) fields['stage'] = body['stage'];
    if (body['config'] !== undefined) fields['config'] = JSON.stringify(body['config']);
    if (body['priority'] !== undefined) fields['priority'] = body['priority'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateGuardrail(params['id']!, fields as any);
    const guardrail = await db.getGuardrail(params['id']!);
    json(res, 200, { guardrail });
  }, { auth: true, csrf: true });

  router.del('/api/admin/guardrails/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteGuardrail(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Routing Policies ────────────────────────────────

  router.get('/api/admin/routing', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.listRoutingPolicies();
    json(res, 200, { policies });
  });

  router.get('/api/admin/routing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const p = await db.getRoutingPolicy(params['id']!);
    if (!p) { json(res, 404, { error: 'Routing policy not found' }); return; }
    json(res, 200, { policy: p });
  });

  router.post('/api/admin/routing', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['strategy']) { json(res, 400, { error: 'name and strategy required' }); return; }
    const id = 'route-' + randomUUID().slice(0, 8);
    await db.createRoutingPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      strategy: body['strategy'] as string,
      constraints: body['constraints'] ? JSON.stringify(body['constraints']) : null,
      weights: body['weights'] ? JSON.stringify(body['weights']) : null,
      fallback_model: (body['fallback_model'] as string) ?? null,
      fallback_provider: (body['fallback_provider'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const policy = await db.getRoutingPolicy(id);
    json(res, 201, { policy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/routing/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getRoutingPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Routing policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['strategy'] !== undefined) fields['strategy'] = body['strategy'];
    if (body['constraints'] !== undefined) fields['constraints'] = JSON.stringify(body['constraints']);
    if (body['weights'] !== undefined) fields['weights'] = JSON.stringify(body['weights']);
    if (body['fallback_model'] !== undefined) fields['fallback_model'] = body['fallback_model'];
    if (body['fallback_provider'] !== undefined) fields['fallback_provider'] = body['fallback_provider'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateRoutingPolicy(params['id']!, fields as any);
    const policy = await db.getRoutingPolicy(params['id']!);
    json(res, 200, { policy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/routing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteRoutingPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Model Pricing ───────────────────────────────────

  router.get('/api/admin/model-pricing', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const pricing = await db.listModelPricing();
    json(res, 200, { pricing });
  });

  router.get('/api/admin/model-pricing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const p = await db.getModelPricing(params['id']!);
    if (!p) { json(res, 404, { error: 'Pricing entry not found' }); return; }
    json(res, 200, { pricing: p });
  });

  router.post('/api/admin/model-pricing', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['model_id'] || !body['provider']) { json(res, 400, { error: 'model_id and provider required' }); return; }
    const id = 'mp-' + randomUUID().slice(0, 8);
    await db.createModelPricing({
      id, model_id: body['model_id'] as string, provider: body['provider'] as string,
      display_name: (body['display_name'] as string) ?? null,
      input_cost_per_1m: (body['input_cost_per_1m'] as number) ?? 0,
      output_cost_per_1m: (body['output_cost_per_1m'] as number) ?? 0,
      quality_score: (body['quality_score'] as number) ?? 0.7,
      source: 'manual', last_synced_at: null, enabled: body['enabled'] !== false ? 1 : 0,
    });
    const pricing = await db.getModelPricing(id);
    json(res, 201, { pricing });
  }, { auth: true, csrf: true });

  router.put('/api/admin/model-pricing/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getModelPricing(params['id']!);
    if (!existing) { json(res, 404, { error: 'Pricing entry not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['model_id'] !== undefined) fields['model_id'] = body['model_id'];
    if (body['provider'] !== undefined) fields['provider'] = body['provider'];
    if (body['display_name'] !== undefined) fields['display_name'] = body['display_name'];
    if (body['input_cost_per_1m'] !== undefined) fields['input_cost_per_1m'] = body['input_cost_per_1m'];
    if (body['output_cost_per_1m'] !== undefined) fields['output_cost_per_1m'] = body['output_cost_per_1m'];
    if (body['quality_score'] !== undefined) fields['quality_score'] = body['quality_score'];
    if (body['source'] !== undefined) fields['source'] = body['source'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateModelPricing(params['id']!, fields as any);
    const pricing = await db.getModelPricing(params['id']!);
    json(res, 200, { pricing });
  }, { auth: true, csrf: true });

  router.del('/api/admin/model-pricing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteModelPricing(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Model Pricing: Sync from providers ─────────────────────

  router.post('/api/admin/model-pricing/sync', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!providers || Object.keys(providers).length === 0) {
      json(res, 400, { error: 'No providers configured — cannot sync pricing' });
      return;
    }
    try {
      const report = await syncModelPricing(db, providers);
      json(res, 200, report);
    } catch (err: unknown) {
      json(res, 500, { error: err instanceof Error ? err.message : 'Sync failed' });
    }
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
    const { createTemplate: ct } = await import('@weaveintel/prompts');
    const tpl = ct({ id: prompt.id, name: prompt.name, template: prompt.template });
    const variables = (body['variables'] as Record<string, unknown>) ?? {};
    try {
      const rendered = tpl.render(variables);
      json(res, 200, { rendered, template: prompt.template, variables: prompt.variables ? JSON.parse(prompt.variables) : [] });
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

  // ── Admin: Workflows ───────────────────────────────────────

  router.get('/api/admin/workflows', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const workflows = await db.listWorkflowDefs();
    json(res, 200, { workflows });
  });

  router.get('/api/admin/workflows/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const w = await db.getWorkflowDef(params['id']!);
    if (!w) { json(res, 404, { error: 'Workflow not found' }); return; }
    json(res, 200, { workflow: w });
  });

  router.post('/api/admin/workflows', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['steps'] || !body['entry_step_id']) { json(res, 400, { error: 'name, steps, and entry_step_id required' }); return; }
    const id = 'wf-' + randomUUID().slice(0, 8);
    await db.createWorkflowDef({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      version: (body['version'] as string) ?? '1.0',
      steps: JSON.stringify(body['steps']),
      entry_step_id: body['entry_step_id'] as string,
      metadata: body['metadata'] ? JSON.stringify(body['metadata']) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const workflow = await db.getWorkflowDef(id);
    json(res, 201, { workflow });
  }, { auth: true, csrf: true });

  router.put('/api/admin/workflows/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getWorkflowDef(params['id']!);
    if (!existing) { json(res, 404, { error: 'Workflow not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['steps'] !== undefined) fields['steps'] = JSON.stringify(body['steps']);
    if (body['entry_step_id'] !== undefined) fields['entry_step_id'] = body['entry_step_id'];
    if (body['metadata'] !== undefined) fields['metadata'] = JSON.stringify(body['metadata']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateWorkflowDef(params['id']!, fields as any);
    const workflow = await db.getWorkflowDef(params['id']!);
    json(res, 200, { workflow });
  }, { auth: true, csrf: true });

  router.del('/api/admin/workflows/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWorkflowDef(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Tool Configs ────────────────────────────────────

  router.get('/api/admin/tools', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tools = await db.listToolConfigs();
    json(res, 200, { tools });
  });

  router.get('/api/admin/tools/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const t = await db.getToolConfig(params['id']!);
    if (!t) { json(res, 404, { error: 'Tool config not found' }); return; }
    json(res, 200, { tool: t });
  });

  router.post('/api/admin/tools', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'tool-' + randomUUID().slice(0, 8);
    await db.createToolConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      category: (body['category'] as string) ?? null, risk_level: (body['risk_level'] as string) ?? 'low',
      requires_approval: body['requires_approval'] ? 1 : 0,
      max_execution_ms: (body['max_execution_ms'] as number) ?? null,
      rate_limit_per_min: (body['rate_limit_per_min'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const tool = await db.getToolConfig(id);
    json(res, 201, { tool });
  }, { auth: true, csrf: true });

  router.put('/api/admin/tools/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tool config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['risk_level'] !== undefined) fields['risk_level'] = body['risk_level'];
    if (body['requires_approval'] !== undefined) fields['requires_approval'] = body['requires_approval'] ? 1 : 0;
    if (body['max_execution_ms'] !== undefined) fields['max_execution_ms'] = body['max_execution_ms'];
    if (body['rate_limit_per_min'] !== undefined) fields['rate_limit_per_min'] = body['rate_limit_per_min'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateToolConfig(params['id']!, fields as any);
    const tool = await db.getToolConfig(params['id']!);
    json(res, 200, { tool });
  }, { auth: true, csrf: true });

  router.del('/api/admin/tools/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteToolConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Skills ──────────────────────────────────────────

  router.get('/api/admin/skills', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const skills = await db.listSkills();
    json(res, 200, { skills });
  });

  router.get('/api/admin/skills/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const skill = await db.getSkill(params['id']!);
    if (!skill) { json(res, 404, { error: 'Skill not found' }); return; }
    json(res, 200, { skill });
  });

  router.post('/api/admin/skills', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['instructions']) {
      json(res, 400, { error: 'name and instructions required' });
      return;
    }

    const id = 'skill-' + randomUUID().slice(0, 8);
    await db.createSkill({
      id,
      name: body['name'] as string,
      description: (body['description'] as string) ?? '',
      category: (body['category'] as string) ?? 'general',
      trigger_patterns: JSON.stringify(Array.isArray(body['trigger_patterns']) ? body['trigger_patterns'] : []),
      instructions: body['instructions'] as string,
      tool_names: body['tool_names'] ? JSON.stringify(body['tool_names']) : null,
      examples: body['examples'] ? JSON.stringify(body['examples']) : null,
      tags: body['tags'] ? JSON.stringify(body['tags']) : null,
      priority: Number(body['priority'] ?? 0),
      version: (body['version'] as string) ?? '1.0',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const skill = await db.getSkill(id);
    json(res, 201, { skill });
  }, { auth: true, csrf: true });

  router.put('/api/admin/skills/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getSkill(params['id']!);
    if (!existing) { json(res, 404, { error: 'Skill not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['trigger_patterns'] !== undefined) fields['trigger_patterns'] = JSON.stringify(Array.isArray(body['trigger_patterns']) ? body['trigger_patterns'] : []);
    if (body['instructions'] !== undefined) fields['instructions'] = body['instructions'];
    if (body['tool_names'] !== undefined) fields['tool_names'] = body['tool_names'] ? JSON.stringify(body['tool_names']) : null;
    if (body['examples'] !== undefined) fields['examples'] = body['examples'] ? JSON.stringify(body['examples']) : null;
    if (body['tags'] !== undefined) fields['tags'] = body['tags'] ? JSON.stringify(body['tags']) : null;
    if (body['priority'] !== undefined) fields['priority'] = Number(body['priority']);
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updateSkill(params['id']!, fields as any);
    const skill = await db.getSkill(params['id']!);
    json(res, 200, { skill });
  }, { auth: true, csrf: true });

  router.del('/api/admin/skills/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSkill(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

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

  // ── Admin: Human Task Policies ─────────────────────────────

  router.get('/api/admin/task-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.listHumanTaskPolicies();
    json(res, 200, { taskPolicies: policies });
  });

  router.get('/api/admin/task-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const p = await db.getHumanTaskPolicy(params['id']!);
    if (!p) { json(res, 404, { error: 'Task policy not found' }); return; }
    json(res, 200, { taskPolicy: p });
  });

  router.post('/api/admin/task-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['trigger']) { json(res, 400, { error: 'name and trigger required' }); return; }
    const id = 'htp-' + randomUUID().slice(0, 8);
    await db.createHumanTaskPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      trigger: body['trigger'] as string, task_type: (body['task_type'] as string) ?? 'approval',
      default_priority: (body['default_priority'] as string) ?? 'normal',
      sla_hours: (body['sla_hours'] as number) ?? null, auto_escalate_after_hours: (body['auto_escalate_after_hours'] as number) ?? null,
      assignment_strategy: (body['assignment_strategy'] as string) ?? 'round-robin',
      assign_to: (body['assign_to'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const taskPolicy = await db.getHumanTaskPolicy(id);
    json(res, 201, { taskPolicy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/task-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getHumanTaskPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Task policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['trigger'] !== undefined) fields['trigger'] = body['trigger'];
    if (body['task_type'] !== undefined) fields['task_type'] = body['task_type'];
    if (body['default_priority'] !== undefined) fields['default_priority'] = body['default_priority'];
    if (body['sla_hours'] !== undefined) fields['sla_hours'] = body['sla_hours'];
    if (body['auto_escalate_after_hours'] !== undefined) fields['auto_escalate_after_hours'] = body['auto_escalate_after_hours'];
    if (body['assignment_strategy'] !== undefined) fields['assignment_strategy'] = body['assignment_strategy'];
    if (body['assign_to'] !== undefined) fields['assign_to'] = body['assign_to'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateHumanTaskPolicy(params['id']!, fields as any);
    const taskPolicy = await db.getHumanTaskPolicy(params['id']!);
    json(res, 200, { taskPolicy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/task-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteHumanTaskPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Task Contracts ──────────────────────────────────

  router.get('/api/admin/contracts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const contracts = await db.listTaskContracts();
    json(res, 200, { contracts });
  });

  router.get('/api/admin/contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getTaskContract(params['id']!);
    if (!c) { json(res, 404, { error: 'Contract not found' }); return; }
    json(res, 200, { contract: c });
  });

  router.post('/api/admin/contracts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'tc-' + randomUUID().slice(0, 8);
    await db.createTaskContract({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      input_schema: body['input_schema'] ? (typeof body['input_schema'] === 'string' ? body['input_schema'] as string : JSON.stringify(body['input_schema'])) : null,
      output_schema: body['output_schema'] ? (typeof body['output_schema'] === 'string' ? body['output_schema'] as string : JSON.stringify(body['output_schema'])) : null,
      acceptance_criteria: body['acceptance_criteria'] ? (typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] as string : JSON.stringify(body['acceptance_criteria'])) : '[]',
      max_attempts: (body['max_attempts'] as number) ?? null,
      timeout_ms: (body['timeout_ms'] as number) ?? null,
      evidence_required: body['evidence_required'] ? (typeof body['evidence_required'] === 'string' ? body['evidence_required'] as string : JSON.stringify(body['evidence_required'])) : null,
      min_confidence: (body['min_confidence'] as number) ?? null,
      require_human_review: body['require_human_review'] ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const contract = await db.getTaskContract(id);
    json(res, 201, { contract });
  }, { auth: true, csrf: true });

  router.put('/api/admin/contracts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getTaskContract(params['id']!);
    if (!existing) { json(res, 404, { error: 'Contract not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['input_schema'] !== undefined) fields['input_schema'] = typeof body['input_schema'] === 'string' ? body['input_schema'] : JSON.stringify(body['input_schema']);
    if (body['output_schema'] !== undefined) fields['output_schema'] = typeof body['output_schema'] === 'string' ? body['output_schema'] : JSON.stringify(body['output_schema']);
    if (body['acceptance_criteria'] !== undefined) fields['acceptance_criteria'] = typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] : JSON.stringify(body['acceptance_criteria']);
    if (body['max_attempts'] !== undefined) fields['max_attempts'] = body['max_attempts'];
    if (body['timeout_ms'] !== undefined) fields['timeout_ms'] = body['timeout_ms'];
    if (body['evidence_required'] !== undefined) fields['evidence_required'] = typeof body['evidence_required'] === 'string' ? body['evidence_required'] : JSON.stringify(body['evidence_required']);
    if (body['min_confidence'] !== undefined) fields['min_confidence'] = body['min_confidence'];
    if (body['require_human_review'] !== undefined) fields['require_human_review'] = body['require_human_review'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateTaskContract(params['id']!, fields as any);
    const contract = await db.getTaskContract(params['id']!);
    json(res, 200, { contract });
  }, { auth: true, csrf: true });

  router.del('/api/admin/contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteTaskContract(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

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
    const id = 'cp-' + randomUUID().slice(0, 8);
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

  // ── Admin: Identity Rules ──────────────────────────────────

  router.get('/api/admin/identity-rules', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listIdentityRules();
    json(res, 200, { 'identity-rules': items });
  });

  router.get('/api/admin/identity-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getIdentityRule(params['id']!);
    if (!c) { json(res, 404, { error: 'Identity rule not found' }); return; }
    json(res, 200, { 'identity-rule': c });
  });

  router.post('/api/admin/identity-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'ident-' + randomUUID().slice(0, 8);
    await db.createIdentityRule({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      resource: (body['resource'] as string) ?? '*',
      action: (body['action'] as string) ?? '*',
      roles: body['roles'] ? (typeof body['roles'] === 'string' ? body['roles'] as string : JSON.stringify(body['roles'])) : '["*"]',
      scopes: body['scopes'] ? (typeof body['scopes'] === 'string' ? body['scopes'] as string : JSON.stringify(body['scopes'])) : '["*"]',
      result: (body['result'] as string) ?? 'allow',
      priority: (body['priority'] as number) ?? 100,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getIdentityRule(id);
    json(res, 201, { 'identity-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/identity-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getIdentityRule(params['id']!);
    if (!existing) { json(res, 404, { error: 'Identity rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['resource'] !== undefined) fields['resource'] = body['resource'];
    if (body['action'] !== undefined) fields['action'] = body['action'];
    if (body['roles'] !== undefined) fields['roles'] = typeof body['roles'] === 'string' ? body['roles'] : JSON.stringify(body['roles']);
    if (body['scopes'] !== undefined) fields['scopes'] = typeof body['scopes'] === 'string' ? body['scopes'] : JSON.stringify(body['scopes']);
    if (body['result'] !== undefined) fields['result'] = body['result'];
    if (body['priority'] !== undefined) fields['priority'] = body['priority'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateIdentityRule(params['id']!, fields as any);
    const item = await db.getIdentityRule(params['id']!);
    json(res, 200, { 'identity-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/identity-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteIdentityRule(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Memory Governance ───────────────────────────────

  router.get('/api/admin/memory-governance', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listMemoryGovernance();
    json(res, 200, { 'memory-governance': items });
  });

  router.get('/api/admin/memory-governance/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getMemoryGovernance(params['id']!);
    if (!c) { json(res, 404, { error: 'Memory governance rule not found' }); return; }
    json(res, 200, { 'memory-governance-rule': c });
  });

  router.post('/api/admin/memory-governance', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'mgov-' + randomUUID().slice(0, 8);
    await db.createMemoryGovernance({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      memory_types: body['memory_types'] ? (typeof body['memory_types'] === 'string' ? body['memory_types'] as string : JSON.stringify(body['memory_types'])) : '["*"]',
      tenant_id: (body['tenant_id'] as string) ?? null,
      block_patterns: body['block_patterns'] ? (typeof body['block_patterns'] === 'string' ? body['block_patterns'] as string : JSON.stringify(body['block_patterns'])) : '[]',
      redact_patterns: body['redact_patterns'] ? (typeof body['redact_patterns'] === 'string' ? body['redact_patterns'] as string : JSON.stringify(body['redact_patterns'])) : '[]',
      max_age: (body['max_age'] as string) ?? null,
      max_entries: (body['max_entries'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getMemoryGovernance(id);
    json(res, 201, { 'memory-governance-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/memory-governance/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMemoryGovernance(params['id']!);
    if (!existing) { json(res, 404, { error: 'Memory governance rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['memory_types'] !== undefined) fields['memory_types'] = typeof body['memory_types'] === 'string' ? body['memory_types'] : JSON.stringify(body['memory_types']);
    if (body['tenant_id'] !== undefined) fields['tenant_id'] = body['tenant_id'];
    if (body['block_patterns'] !== undefined) fields['block_patterns'] = typeof body['block_patterns'] === 'string' ? body['block_patterns'] : JSON.stringify(body['block_patterns']);
    if (body['redact_patterns'] !== undefined) fields['redact_patterns'] = typeof body['redact_patterns'] === 'string' ? body['redact_patterns'] : JSON.stringify(body['redact_patterns']);
    if (body['max_age'] !== undefined) fields['max_age'] = body['max_age'];
    if (body['max_entries'] !== undefined) fields['max_entries'] = body['max_entries'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateMemoryGovernance(params['id']!, fields as any);
    const item = await db.getMemoryGovernance(params['id']!);
    json(res, 200, { 'memory-governance-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/memory-governance/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteMemoryGovernance(params['id']!);
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
    const id = 'mer-' + randomUUID().slice(0, 8);
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
    const id = 'sp-' + randomUUID().slice(0, 8);
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
    const id = 'he-' + randomUUID().slice(0, 8);
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
    const id = 'sa-' + randomUUID().slice(0, 8);
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
    const id = 'ec-' + randomUUID().slice(0, 8);
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
    const id = 'tr-' + randomUUID().slice(0, 8);
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
    const id = 'rs-' + randomUUID().slice(0, 8);
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
    const id = 'trig-' + randomUUID().slice(0, 8);
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
    const id = 'tc-' + randomUUID().slice(0, 8);
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
    const id = 'sbx-' + randomUUID().slice(0, 8);
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
    const id = 'ext-' + randomUUID().slice(0, 8);
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
    const id = 'artpol-' + randomUUID().slice(0, 8);
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
    const id = 'rel-' + randomUUID().slice(0, 8);
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
    const id = 'collab-' + randomUUID().slice(0, 8);
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

  // ── Admin: Compliance Rules ────────────────────────────────

  router.get('/api/admin/compliance-rules', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const items = await db.listComplianceRules();
    json(res, 200, { 'compliance-rules': items });
  });

  router.get('/api/admin/compliance-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getComplianceRule(params['id']!);
    if (!c) { json(res, 404, { error: 'Compliance rule not found' }); return; }
    json(res, 200, { 'compliance-rule': c });
  });

  router.post('/api/admin/compliance-rules', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'comp-' + randomUUID().slice(0, 8);
    await db.createComplianceRule({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      rule_type: (body['rule_type'] as string) ?? 'retention',
      target_resource: (body['target_resource'] as string) ?? '*',
      retention_days: (body['retention_days'] as number) ?? null,
      region: (body['region'] as string) ?? null,
      consent_purpose: (body['consent_purpose'] as string) ?? null,
      action: (body['action'] as string) ?? 'notify',
      config: body['config'] != null ? (typeof body['config'] === 'string' ? body['config'] as string : JSON.stringify(body['config'])) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const item = await db.getComplianceRule(id);
    json(res, 201, { 'compliance-rule': item });
  }, { auth: true, csrf: true });

  router.put('/api/admin/compliance-rules/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getComplianceRule(params['id']!);
    if (!existing) { json(res, 404, { error: 'Compliance rule not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['rule_type'] !== undefined) fields['rule_type'] = body['rule_type'];
    if (body['target_resource'] !== undefined) fields['target_resource'] = body['target_resource'];
    if (body['retention_days'] !== undefined) fields['retention_days'] = body['retention_days'];
    if (body['region'] !== undefined) fields['region'] = body['region'];
    if (body['consent_purpose'] !== undefined) fields['consent_purpose'] = body['consent_purpose'];
    if (body['action'] !== undefined) fields['action'] = body['action'];
    if (body['config'] !== undefined) fields['config'] = body['config'] != null ? (typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config'])) : null;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateComplianceRule(params['id']!, fields as any);
    const item = await db.getComplianceRule(params['id']!);
    json(res, 200, { 'compliance-rule': item });
  }, { auth: true, csrf: true });

  router.del('/api/admin/compliance-rules/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteComplianceRule(params['id']!);
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
    const id = 'graph-' + randomUUID().slice(0, 8);
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
    const id = 'plug-' + randomUUID().slice(0, 8);
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
    const id = 'scaf-' + randomUUID().slice(0, 8);
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
    const id = 'rcp-' + randomUUID().slice(0, 8);
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
    const id = 'wgt-' + randomUUID().slice(0, 8);
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
    const id = 'val-' + randomUUID().slice(0, 8);
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
