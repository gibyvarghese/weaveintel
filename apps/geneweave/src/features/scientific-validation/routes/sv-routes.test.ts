/**
 * Scientific Validation Routes — unit tests
 *
 * Spins up an in-process HTTP server with `registerSVRoutes` wired to a
 * fully mocked DatabaseAdapter and SVWorkflowRunner, then drives all 7
 * endpoints via fetch.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerSVRoutes } from './index.js';
import type { DatabaseAdapter } from '../../../db.js';
import type { SVWorkflowRunner } from '../runner.js';
import type {
  SvHypothesisRow,
  SvVerdictRow,
  SvSubClaimRow,
  SvEvidenceEventRow,
  SvAgentTurnRow,
} from '../../../db-types.js';

// ─── Minimal in-process HTTP harness ─────────────────────────────────────────

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: { userId: string; tenantId?: string | null } | null,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  auth: boolean;
}

const routes: Route[] = [];

function matchRoute(method: string, pathname: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (m) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((n, i) => { params[n] = m[i + 1] ?? ''; });
      return { route, params };
    }
  }
  return null;
}

function registerRoute(method: string, path: string, handler: RouteHandler, opts?: { auth?: boolean }) {
  const paramNames: string[] = [];
  const pat = path.replace(/:([^/]+)/g, (_m, n: string) => { paramNames.push(n); return '([^/]+)'; });
  routes.push({ method, pattern: new RegExp(`^${pat}$`), paramNames, handler, auth: opts?.auth ?? false });
}

const router = {
  get: (p: string, h: RouteHandler, opts?: { auth?: boolean }) => registerRoute('GET', p, h, opts),
  post: (p: string, h: RouteHandler, opts?: { auth?: boolean }) => registerRoute('POST', p, h, opts),
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });

// ─── Mock DB adapter ─────────────────────────────────────────────────────────

const NOW = '2024-01-01T00:00:00.000Z';

const baseHypothesis: SvHypothesisRow = {
  id: 'hyp-001',
  tenant_id: 'tenant-a',
  submitted_by: 'user-1',
  title: 'Test Hypothesis',
  statement: 'The sky is blue.',
  domain_tags: '["physics"]',
  status: 'queued',
  budget_envelope_id: 'budget-1',
  workflow_run_id: null,
  trace_id: 'trace-001',
  contract_id: 'contract-001',
  created_at: NOW,
  updated_at: NOW,
};

const baseVerdict: SvVerdictRow = {
  id: 'verdict-001',
  hypothesis_id: 'hyp-001',
  tenant_id: 'tenant-a',
  verdict: 'supported',
  confidence_lo: 0.7,
  confidence_hi: 0.9,
  key_evidence_ids: '[]',
  falsifiers: '[]',
  limitations: 'Small sample size.',
  contract_id: 'contract-001',
  replay_trace_id: 'trace-001',
  emitted_by: 'supervisor',
  created_at: NOW,
};

const baseSubClaim: SvSubClaimRow = {
  id: 'sc-001',
  hypothesis_id: 'hyp-001',
  tenant_id: 'tenant-a',
  parent_sub_claim_id: null,
  statement: 'Light scatters.',
  claim_type: 'mechanism',
  testability_score: 0.9,
  created_at: NOW,
};

const baseEvidence: SvEvidenceEventRow = {
  id: 'ev-001',
  hypothesis_id: 'hyp-001',
  step_id: 'literature',
  agent_id: 'literature-agent',
  evidence_id: 'eid-001',
  kind: 'lit_hit',
  summary: 'Blue light scatters.',
  source_type: 'http_fetch',
  tool_key: 'arxiv.search',
  reproducibility_hash: null,
  created_at: NOW,
};

const mockDb: Partial<DatabaseAdapter> = {
  createHypothesis: vi.fn().mockResolvedValue(undefined),
  getHypothesis: vi.fn().mockResolvedValue(baseHypothesis),
  updateHypothesisStatus: vi.fn().mockResolvedValue(undefined),
  getVerdictByHypothesis: vi.fn().mockResolvedValue(baseVerdict),
  getVerdictById: vi.fn().mockResolvedValue(baseVerdict),
  listSubClaims: vi.fn().mockResolvedValue([baseSubClaim]),
  listEvidenceEvents: vi.fn().mockResolvedValue([]),
  listAgentTurns: vi.fn().mockResolvedValue([]),
};

const mockRunner: Partial<SVWorkflowRunner> = {
  startRun: vi.fn().mockResolvedValue('run-001'),
  cancelRun: vi.fn().mockResolvedValue(undefined),
};

// ─── Test server setup ────────────────────────────────────────────────────────

let baseUrl = '';
let server: ReturnType<typeof createServer>;

const AUTH = { userId: 'user-1', tenantId: 'tenant-a' };

beforeAll(() => {
  registerSVRoutes(
    router,
    mockDb as DatabaseAdapter,
    json,
    readBody,
    mockRunner as SVWorkflowRunner,
  );

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const match = matchRoute(req.method ?? 'GET', url.pathname);
    if (!match) { json(res, 404, { error: 'Not found' }); return; }
    await match.route.handler(req, res, match.params, AUTH);
  });

  return new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as Record<string, unknown> };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/sv/hypotheses', () => {
  it('creates a hypothesis and returns 201 with id + status=queued', async () => {
    const { status, data } = await req('POST', '/api/sv/hypotheses', {
      title: 'Test Hypothesis',
      statement: 'The sky is blue.',
      domainTags: ['physics'],
      budgetId: 'budget-1',
    });
    expect(status).toBe(201);
    expect(typeof data['id']).toBe('string');
    expect(data['status']).toBe('queued');
    expect(typeof data['traceId']).toBe('string');
    expect(typeof data['contractId']).toBe('string');
    expect(mockDb.createHypothesis).toHaveBeenCalled();
    expect(mockRunner.startRun).toHaveBeenCalled();
  });

  it('returns 400 when title is missing', async () => {
    const { status, data } = await req('POST', '/api/sv/hypotheses', {
      statement: 'Something.',
    });
    expect(status).toBe(400);
    expect(data['error']).toMatch(/title/i);
  });

  it('returns 400 when statement is missing', async () => {
    const { status, data } = await req('POST', '/api/sv/hypotheses', {
      title: 'A title',
    });
    expect(status).toBe(400);
    expect(data['error']).toMatch(/statement/i);
  });

  it('returns 400 on invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/api/sv/hypotheses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/sv/hypotheses/:id', () => {
  it('returns 200 with hypothesis and verdict', async () => {
    const { status, data } = await req('GET', '/api/sv/hypotheses/hyp-001');
    expect(status).toBe(200);
    const hyp = data['hypothesis'] as Record<string, unknown>;
    expect(hyp['id']).toBe('hyp-001');
    expect(hyp['title']).toBe('Test Hypothesis');
    expect(Array.isArray(hyp['domainTags'])).toBe(true);
    const v = data['verdict'] as Record<string, unknown>;
    expect(v['verdict']).toBe('supported');
    expect(typeof v['confidenceLo']).toBe('number');
  });

  it('returns 404 when hypothesis not found', async () => {
    vi.mocked(mockDb.getHypothesis!).mockResolvedValueOnce(null);
    const { status } = await req('GET', '/api/sv/hypotheses/missing');
    expect(status).toBe(404);
  });

  it('returns null verdict when no verdict exists', async () => {
    vi.mocked(mockDb.getVerdictByHypothesis!).mockResolvedValueOnce(null);
    const { data } = await req('GET', '/api/sv/hypotheses/hyp-001');
    expect(data['verdict']).toBeNull();
  });
});

describe('POST /api/sv/hypotheses/:id/cancel', () => {
  it('cancels an in-progress run and returns 200', async () => {
    vi.mocked(mockDb.getHypothesis!).mockResolvedValueOnce({ ...baseHypothesis, status: 'running' });
    const { status, data } = await req('POST', '/api/sv/hypotheses/hyp-001/cancel');
    expect(status).toBe(200);
    expect(data['status']).toBe('abandoned');
    // runner.cancelRun is called when runner is present
    expect(mockRunner.cancelRun).toHaveBeenCalledWith('hyp-001');
  });

  it('returns 200 idempotently when hypothesis is already abandoned', async () => {
    vi.mocked(mockDb.getHypothesis!).mockResolvedValueOnce({ ...baseHypothesis, status: 'abandoned' });
    const { status, data } = await req('POST', '/api/sv/hypotheses/hyp-001/cancel');
    expect(status).toBe(200);
    expect(data['status']).toBe('abandoned');
  });

  it('returns 404 when hypothesis not found', async () => {
    vi.mocked(mockDb.getHypothesis!).mockResolvedValueOnce(null);
    const { status } = await req('POST', '/api/sv/hypotheses/missing/cancel');
    expect(status).toBe(404);
  });
});

describe('POST /api/sv/hypotheses/:id/reproduce', () => {
  it('creates a new hypothesis with new IDs and returns 201', async () => {
    vi.mocked(mockDb.getHypothesis!).mockResolvedValueOnce({ ...baseHypothesis, status: 'verdict' });
    vi.mocked(mockDb.createHypothesis!).mockResolvedValueOnce(undefined);
    const { status, data } = await req('POST', '/api/sv/hypotheses/hyp-001/reproduce');
    expect(status).toBe(201);
    expect(typeof data['id']).toBe('string');
    expect(data['id']).not.toBe('hyp-001'); // new UUID
    expect(data['status']).toBe('queued');
    expect(data['originalId']).toBe('hyp-001');
  });

  it('returns 404 when original hypothesis not found', async () => {
    vi.mocked(mockDb.getHypothesis!).mockResolvedValueOnce(null);
    const { status } = await req('POST', '/api/sv/hypotheses/missing/reproduce');
    expect(status).toBe(404);
  });
});

describe('GET /api/sv/verdicts/:id/bundle', () => {
  it('returns a JSON bundle with verdict, hypothesis, subclaims and evidence', async () => {
    vi.mocked(mockDb.getVerdictById!).mockResolvedValueOnce(baseVerdict);
    vi.mocked(mockDb.getHypothesis!).mockResolvedValueOnce(baseHypothesis);
    vi.mocked(mockDb.listSubClaims!).mockResolvedValueOnce([baseSubClaim]);
    vi.mocked(mockDb.listEvidenceEvents!).mockResolvedValueOnce([baseEvidence]);

    const res = await fetch(`${baseUrl}/api/sv/verdicts/verdict-001/bundle`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const bundle = await res.json() as Record<string, unknown>;
    expect(bundle['verdict']).toBeTruthy();
    expect(bundle['hypothesis']).toBeTruthy();
    expect(Array.isArray(bundle['subClaims'])).toBe(true);
    expect(Array.isArray(bundle['evidenceEvents'])).toBe(true);
  });

  it('returns 404 when verdict not found', async () => {
    vi.mocked(mockDb.getVerdictById!).mockResolvedValueOnce(null);
    const { status } = await req('GET', '/api/sv/verdicts/missing/bundle');
    expect(status).toBe(404);
  });
});
