/**
 * @weaveintel/geneweave — Admin MCP Gateway Client routes (Phase 5)
 *
 * CRUD endpoints for per-client MCP gateway bearer tokens. Each client row
 * stores only the SHA-256 digest of the token, never the plaintext. The
 * mint flow returns the freshly generated plaintext exactly once on create
 * (or rotate); callers must capture it then. After that the gateway can
 * verify presented tokens by hashing them and looking up the row.
 *
 * The list/get responses never include the plaintext — only the digest, the
 * scope, the audit chatId, and the timestamps.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { hashGatewayToken } from '../../mcp-gateway.js';

/** Generate a cryptographically random 32-byte bearer token, hex-encoded. */
function mintToken(): string {
  return randomBytes(32).toString('hex');
}

export function registerMCPGatewayClientRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  // ── List ───────────────────────────────────────────────────
  router.get('/api/admin/mcp-gateway-clients', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const clients = await db.listMCPGatewayClients();
    json(res, 200, { clients });
  }, { auth: true });

  // ── Get by ID ──────────────────────────────────────────────
  router.get('/api/admin/mcp-gateway-clients/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const client = await db.getMCPGatewayClient(params['id']!);
    if (!client) { json(res, 404, { error: 'MCP gateway client not found' }); return; }
    json(res, 200, { client });
  }, { auth: true });

  // ── Create ─────────────────────────────────────────────────
  // Body: { name, description?, allowed_classes?: string[], audit_chat_id?, enabled? }
  // Response 201: { client, token } — the plaintext token is returned
  // exactly once and never persisted. Operators must capture it.
  router.post('/api/admin/mcp-gateway-clients', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const name = body['name'];
    if (typeof name !== 'string' || name.length === 0) {
      json(res, 400, { error: 'name required' }); return;
    }
    const allowedRaw = body['allowed_classes'];
    let allowed_classes: string | null = null;
    if (allowedRaw !== undefined && allowedRaw !== null) {
      allowed_classes = typeof allowedRaw === 'string' ? allowedRaw : JSON.stringify(allowedRaw);
    }
    const id = randomUUID();
    const plaintext = mintToken();
    const rlRaw = body['rate_limit_per_minute'];
    let rate_limit_per_minute: number | null = null;
    if (typeof rlRaw === 'number' && Number.isFinite(rlRaw) && rlRaw > 0) {
      rate_limit_per_minute = Math.floor(rlRaw);
    }
    await db.createMCPGatewayClient({
      id,
      name,
      description: (body['description'] as string) ?? null,
      token_hash: hashGatewayToken(plaintext),
      allowed_classes,
      audit_chat_id: (body['audit_chat_id'] as string) ?? null,
      enabled: body['enabled'] === false ? 0 : 1,
      rate_limit_per_minute,
    });
    const client = await db.getMCPGatewayClient(id);
    json(res, 201, { client, token: plaintext });
  }, { auth: true, csrf: true });

  // ── Update ─────────────────────────────────────────────────
  // Token rotation is intentionally NOT part of update — use the dedicated
  // /:id/rotate action so operators have an explicit audit trail of when
  // the secret changed.
  router.put('/api/admin/mcp-gateway-clients/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMCPGatewayClient(params['id']!);
    if (!existing) { json(res, 404, { error: 'MCP gateway client not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['allowed_classes'] !== undefined) {
      fields['allowed_classes'] = body['allowed_classes'] === null
        ? null
        : (typeof body['allowed_classes'] === 'string'
          ? body['allowed_classes']
          : JSON.stringify(body['allowed_classes']));
    }
    if (body['audit_chat_id'] !== undefined) fields['audit_chat_id'] = body['audit_chat_id'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    if (body['rate_limit_per_minute'] !== undefined) {
      const v = body['rate_limit_per_minute'];
      if (v === null) {
        fields['rate_limit_per_minute'] = null;
      } else if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        fields['rate_limit_per_minute'] = Math.floor(v);
      } else {
        json(res, 400, { error: 'rate_limit_per_minute must be a positive number or null' });
        return;
      }
    }
    await db.updateMCPGatewayClient(params['id']!, fields as Parameters<DatabaseAdapter['updateMCPGatewayClient']>[1]);
    const client = await db.getMCPGatewayClient(params['id']!);
    json(res, 200, { client });
  }, { auth: true, csrf: true });

  // ── Delete ─────────────────────────────────────────────────
  router.del('/api/admin/mcp-gateway-clients/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteMCPGatewayClient(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Revoke action ──────────────────────────────────────────
  // Soft-delete: sets enabled=0 and revoked_at; keeps the row for audit.
  router.post('/api/admin/mcp-gateway-clients/:id/revoke', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMCPGatewayClient(params['id']!);
    if (!existing) { json(res, 404, { error: 'MCP gateway client not found' }); return; }
    await db.revokeMCPGatewayClient(params['id']!);
    const client = await db.getMCPGatewayClient(params['id']!);
    json(res, 200, { client });
  }, { auth: true, csrf: true });

  // ── Rotate action ──────────────────────────────────────────
  // Mints a fresh bearer token, replaces the stored hash, and returns the
  // new plaintext exactly once. The previous token immediately stops
  // working on the next gateway request.
  router.post('/api/admin/mcp-gateway-clients/:id/rotate', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getMCPGatewayClient(params['id']!);
    if (!existing) { json(res, 404, { error: 'MCP gateway client not found' }); return; }
    const plaintext = mintToken();
    await db.updateMCPGatewayClient(params['id']!, {
      token_hash: hashGatewayToken(plaintext),
    });
    const client = await db.getMCPGatewayClient(params['id']!);
    json(res, 200, { client, token: plaintext });
  }, { auth: true, csrf: true });
}
