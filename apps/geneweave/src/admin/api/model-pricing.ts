import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { syncModelPricing } from '../../pricing-sync.js';

/**
 * Register model pricing admin routes
 *
 * Routes:
 * - GET /api/admin/model-pricing
 * - GET /api/admin/model-pricing/:id
 * - POST /api/admin/model-pricing
 * - PUT /api/admin/model-pricing/:id
 * - DEL /api/admin/model-pricing/:id
 * - POST /api/admin/model-pricing/sync
 */
export function registerModelPricingRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers
): void {
  const { json, readBody, providers } = helpers;

  router.get('/api/admin/model-pricing', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const pricing = await db.listModelPricing();
    json(res, 200, { pricing });
  }, { auth: true });

  router.get('/api/admin/model-pricing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const p = await db.getModelPricing(params['id']!);
    if (!p) { json(res, 404, { error: 'Pricing entry not found' }); return; }
    json(res, 200, { pricing: p });
  }, { auth: true });

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

  // Sync from providers
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
}
