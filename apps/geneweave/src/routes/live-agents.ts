import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';

// In-memory run registry (process-scoped, non-durable).
const liveAgentRuns = new Map<string, { userId: string; status: string; createdAt: string; agentId?: string; config?: unknown }>();

export function registerLiveAgentRoutes(router: Router, _db: DatabaseAdapter): void {

  // ── Live-agent lifecycle ────────────────────────────────────────────────────

  // Start a new live-agent run. Returns a runId that the client can poll.
  router.post('/api/live-agents/runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { agentId?: string; config?: unknown } = {};
    try { if (raw.trim()) body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const runId = newUUIDv7();
    liveAgentRuns.set(runId, {
      userId: auth.userId,
      status: 'running',
      createdAt: new Date().toISOString(),
      agentId: body.agentId,
      config: body.config,
    });
    json(res, 200, { runId, status: 'running' });
  }, { auth: true, csrf: true });

  // Get status of a live-agent run.
  router.get('/api/live-agents/runs/:runId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = liveAgentRuns.get(params['runId']!);
    if (!run || run.userId !== auth.userId) { json(res, 404, { error: 'Run not found' }); return; }
    json(res, 200, { runId: params['runId'], ...run });
  });

  // Stop a live-agent run.
  router.post('/api/live-agents/runs/:runId/stop', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = liveAgentRuns.get(params['runId']!);
    if (!run || run.userId !== auth.userId) { json(res, 404, { error: 'Run not found' }); return; }
    run.status = 'stopped';
    json(res, 200, { runId: params['runId'], status: 'stopped' });
  }, { auth: true, csrf: true });

  // Resume a live-agent run (idempotent — running runs stay running).
  router.post('/api/live-agents/runs/:runId/resume', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = liveAgentRuns.get(params['runId']!);
    if (!run || run.userId !== auth.userId) { json(res, 404, { error: 'Run not found' }); return; }
    if (run.status === 'stopped' || run.status === 'paused') {
      run.status = 'running';
    }
    json(res, 200, { runId: params['runId'], status: run.status });
  }, { auth: true, csrf: true });

  // List all live-agent runs for the authenticated user.
  router.get('/api/live-agents/runs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const runs = Array.from(liveAgentRuns.entries())
      .filter(([, r]) => r.userId === auth.userId)
      .map(([runId, r]) => ({ runId, ...r }));
    json(res, 200, { runs });
  });

}
