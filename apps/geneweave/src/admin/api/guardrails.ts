import { newUUIDv7, weaveContext, weaveRuntime } from '@weaveintel/core';
import type { ExecutionContext, Guardrail, GuardrailRevisionStore, GuardrailStage, GuardrailType, WeaveRuntime } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { GuardrailRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { recordGuardrailChange } from '../../guardrail-revision-store.js';

// Use the app's runtime when available so weaveAudit writes to durable KV.
function makeAdminCtx(runtime?: WeaveRuntime): ExecutionContext {
  return weaveContext({ runtime: runtime ?? weaveRuntime() });
}

function rowToGuardrail(g: GuardrailRow): Guardrail {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? undefined,
    type: g.type as GuardrailType,
    stage: g.stage as GuardrailStage,
    config: g.config ? JSON.parse(g.config) as Record<string, unknown> : {},
    priority: g.priority,
    enabled: g.enabled === 1,
  };
}

/**
 * Register guardrail admin routes.
 * All create / update / delete mutations are tracked in guardrail_revisions.
 *
 * Routes:
 * - GET  /api/admin/guardrails
 * - GET  /api/admin/guardrails/:id
 * - GET  /api/admin/guardrails/:id/revisions
 * - POST /api/admin/guardrails
 * - PUT  /api/admin/guardrails/:id
 * - DEL  /api/admin/guardrails/:id
 */
export function registerGuardrailRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
  revisionStore?: GuardrailRevisionStore,
  runtime?: WeaveRuntime,
): void {
  const { json, readBody } = helpers;

  router.get('/api/admin/guardrails', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const guardrails = await db.listGuardrails();
    json(res, 200, { guardrails });
  }, { auth: true });

  router.get('/api/admin/guardrails/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const g = await db.getGuardrail(params['id']!);
    if (!g) { json(res, 404, { error: 'Guardrail not found' }); return; }
    json(res, 200, { guardrail: g });
  }, { auth: true });

  // New: revision history endpoint
  router.get('/api/admin/guardrails/:id/revisions', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (!revisionStore) { json(res, 200, { revisions: [] }); return; }
    const revisions = await revisionStore.list(params['id']!);
    json(res, 200, { revisions });
  }, { auth: true });

  router.post('/api/admin/guardrails', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['type']) { json(res, 400, { error: 'name and type required' }); return; }
    const id = 'guard-' + newUUIDv7().slice(-8);
    await db.createGuardrail({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      type: body['type'] as string, stage: (body['stage'] as string) ?? 'pre',
      config: body['config'] ? JSON.stringify(body['config']) : null,
      priority: (body['priority'] as number) ?? 0, enabled: body['enabled'] !== false ? 1 : 0,
    });
    const guardrail = await db.getGuardrail(id);
    if (guardrail && revisionStore) {
      const ctx = makeAdminCtx(runtime);
      await recordGuardrailChange(revisionStore, ctx, {
        guardrailId: id,
        actor: typeof auth === 'object' && auth !== null && 'userId' in auth ? String((auth as { userId: string }).userId) : 'admin',
        reason: 'Created via admin API',
        snapshot: rowToGuardrail(guardrail),
      });
    }
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
    await db.updateGuardrail(params['id']!, fields as Partial<Omit<GuardrailRow, 'id' | 'created_at' | 'updated_at'>>);
    const guardrail = await db.getGuardrail(params['id']!);
    if (guardrail && revisionStore) {
      const ctx = makeAdminCtx(runtime);
      await recordGuardrailChange(revisionStore, ctx, {
        guardrailId: params['id']!,
        actor: typeof auth === 'object' && auth !== null && 'userId' in auth ? String((auth as { userId: string }).userId) : 'admin',
        reason: (body['reason'] as string) ?? 'Updated via admin API',
        snapshot: rowToGuardrail(guardrail),
        before: rowToGuardrail(existing),
      });
    }
    json(res, 200, { guardrail });
  }, { auth: true, csrf: true });

  router.del('/api/admin/guardrails/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getGuardrail(params['id']!);
    if (existing && revisionStore) {
      const ctx = makeAdminCtx(runtime);
      await recordGuardrailChange(revisionStore, ctx, {
        guardrailId: params['id']!,
        actor: typeof auth === 'object' && auth !== null && 'userId' in auth ? String((auth as { userId: string }).userId) : 'admin',
        reason: 'Deleted via admin API',
        snapshot: { ...rowToGuardrail(existing), enabled: false },
        before: rowToGuardrail(existing),
      });
    }
    await db.deleteGuardrail(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });
}
