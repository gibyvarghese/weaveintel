/**
 * @weaveintel/geneweave — Admin Tool Config routes
 *
 * Modular CRUD endpoints for tool configurations.
 */

import { randomUUID } from 'node:crypto';
import { normalizeCallableDescription } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';

export function registerToolRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody, requireDetailedDescription } = helpers;

  router.get('/api/admin/tools', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tools = await db.listToolConfigs();
    json(res, 200, { tools });
  }, { auth: true });

  router.get('/api/admin/tools/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const t = await db.getToolConfig(params['id']!);
    if (!t) { json(res, 404, { error: 'Tool config not found' }); return; }
    json(res, 200, { tool: t });
  }, { auth: true });

  router.post('/api/admin/tools', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const validatedDescription = requireDetailedDescription(body['description'], 'tool', res);
    if (!validatedDescription) return;
    const id = 'tool-' + randomUUID().slice(0, 8);
    await db.createToolConfig({
      id, name: body['name'] as string, description: validatedDescription,
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
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'tool', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
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
}
