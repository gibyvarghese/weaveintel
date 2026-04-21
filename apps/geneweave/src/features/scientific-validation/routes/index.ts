/**
 * Scientific Validation — HTTP route stubs
 *
 * Phase 2: all routes are wired and authenticated; bodies return 501 Not Implemented.
 * Implementations land in Phase 3 (workflow) and Phase 4 (SSE + bundle).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../../../db.js';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: { userId: string; tenantId?: string | null } | null,
) => Promise<void>;

type JsonHelper = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBodyHelper = (req: IncomingMessage) => Promise<string>;

interface Router {
  get(path: string, handler: RouteHandler, opts?: { auth?: boolean; csrf?: boolean }): void;
  post(path: string, handler: RouteHandler, opts?: { auth?: boolean; csrf?: boolean }): void;
}

export function registerSVRoutes(
  router: Router,
  _db: DatabaseAdapter,
  json: JsonHelper,
  _readBody: ReadBodyHelper,
): void {
  // POST /api/sv/hypotheses
  // Submit a new hypothesis for validation. Idempotent via Idempotency-Key header.
  // Starts the scientific validation workflow asynchronously.
  router.post('/api/sv/hypotheses', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 501, { error: 'Not Implemented', feature: 'scientific-validation', route: 'POST /api/sv/hypotheses' });
  }, { auth: true, csrf: true });

  // GET /api/sv/hypotheses/:id
  // Retrieve a hypothesis plus its verdict (if available).
  // Returns 404 if the hypothesis does not belong to the authenticated tenant.
  router.get('/api/sv/hypotheses/:id', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 501, { error: 'Not Implemented', feature: 'scientific-validation', route: 'GET /api/sv/hypotheses/:id' });
  }, { auth: true });

  // GET /api/sv/hypotheses/:id/events
  // SSE stream of contract evidence items as they are written during the run.
  // Supports Last-Event-ID header for resume.
  router.get('/api/sv/hypotheses/:id/events', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 501, { error: 'Not Implemented', feature: 'scientific-validation', route: 'GET /api/sv/hypotheses/:id/events' });
  }, { auth: true });

  // GET /api/sv/hypotheses/:id/dialogue
  // SSE stream of agent turns and deliberation rounds.
  // Supports Last-Event-ID header for resume.
  router.get('/api/sv/hypotheses/:id/dialogue', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 501, { error: 'Not Implemented', feature: 'scientific-validation', route: 'GET /api/sv/hypotheses/:id/dialogue' });
  }, { auth: true });

  // POST /api/sv/hypotheses/:id/cancel
  // Cancel an in-progress validation run (triggers workflow compensation).
  // Idempotent: cancelling an already-abandoned run returns 200.
  router.post('/api/sv/hypotheses/:id/cancel', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 501, { error: 'Not Implemented', feature: 'scientific-validation', route: 'POST /api/sv/hypotheses/:id/cancel' });
  }, { auth: true, csrf: true });

  // POST /api/sv/hypotheses/:id/reproduce
  // Re-run validation from the recorded replay trace. Creates a new trace_id and contract_id.
  // Requires Idempotency-Key header. Only the original submitter or a user with reproduce ACL may call this.
  router.post('/api/sv/hypotheses/:id/reproduce', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 501, { error: 'Not Implemented', feature: 'scientific-validation', route: 'POST /api/sv/hypotheses/:id/reproduce' });
  }, { auth: true, csrf: true });

  // GET /api/sv/verdicts/:id/bundle
  // Download the complete replay trace bundle as application/zip.
  router.get('/api/sv/verdicts/:id/bundle', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 501, { error: 'Not Implemented', feature: 'scientific-validation', route: 'GET /api/sv/verdicts/:id/bundle' });
  }, { auth: true });
}
