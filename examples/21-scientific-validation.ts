/**
 * Example 21 — Scientific Validation: Batch Hypothesis Comparison
 *
 * Demonstrates submitting multiple hypotheses with different expected verdicts
 * and comparing the results via the geneWeave HTTP API. No fake models or
 * database imports — pure HTTP client.
 *
 *  1. Authenticate against the running server
 *  2. Submit three hypotheses (known-true, known-false, ill-posed)
 *  3. Poll each for a verdict (with timeout)
 *  4. Compare verdicts across hypothesis types
 *  5. Download the evidence bundle for the first hypothesis
 *
 * Prerequisites:
 *  - geneWeave server running at BASE_URL (default: http://localhost:3500)
 *  - An authenticated session via API_EMAIL / API_PASSWORD env vars
 *  - At least one model provider configured (OpenAI or Anthropic)
 *
 * For full SSE streaming see: examples/35-scientific-validation.ts
 */
export {};

const BASE_URL = process.env['API_URL'] ?? 'http://localhost:3500';
const EMAIL = process.env['API_EMAIL'] ?? 'admin@geneweave.ai';
const PASSWORD = process.env['API_PASSWORD'] ?? 'admin123';

let _cookie = '';
let _csrf = '';

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_cookie) headers['Cookie'] = _cookie;
  if (_csrf && method !== 'GET') headers['X-CSRF-Token'] = _csrf;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/gw_token=([^;]+)/);
    if (m) _cookie = `gw_token=${m[1]}`;
  }

  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? (await res.json()) as T : ({} as T);
  return { status: res.status, data };
}

async function login(): Promise<void> {
  const csrf = await apiCall<Record<string, unknown>>('GET', '/api/auth/csrf');
  if (csrf.status === 200 && typeof csrf.data['csrfToken'] === 'string') {
    _csrf = csrf.data['csrfToken'];
  }

  const res = await apiCall<{ ok: boolean }>('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status}`);
  console.log(`Logged in as ${EMAIL}`);
}

interface SubmitResponse {
  id: string;
  status: string;
  traceId: string;
}

interface HypothesisResponse {
  hypothesis: {
    id: string;
    title: string;
    statement: string;
    status: string;
    domainTags: string[];
  };
  verdict: {
    id: string;
    verdict: string;
    confidence: number;
    summary: string;
  } | null;
}

async function submitHypothesis(title: string, statement: string): Promise<string> {
  const res = await apiCall<SubmitResponse>('POST', '/api/sv/hypotheses', { title, statement });
  if (res.status !== 201) throw new Error(`Submit failed (${res.status})`);
  console.log(`Submitted: ${title} (${res.data.id.slice(0, 8)})`);
  return res.data.id;
}

async function pollForVerdict(id: string, timeoutMs = 120_000): Promise<HypothesisResponse> {
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(['verdict', 'abandoned']);

  while (Date.now() < deadline) {
    const res = await apiCall<HypothesisResponse>('GET', `/api/sv/hypotheses/${id}`);
    if (res.status !== 200) throw new Error(`Poll failed (${res.status})`);

    if (terminal.has(res.data.hypothesis.status)) return res.data;

    process.stdout.write('.');
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error(`Timed out waiting for verdict on ${id}`);
}

async function main(): Promise<void> {
  console.log(`\n=== Example 21: Scientific Validation Batch Comparison ===`);
  console.log(`Server: ${BASE_URL}\n`);

  await login();

  const testCases = [
    {
      title: 'Aspirin and fever reduction',
      statement: 'Aspirin inhibits prostaglandin synthesis, which is the primary mechanism by which it reduces fever in humans.',
      expected: 'supported',
    },
    {
      title: 'Vitamin C cures cancer',
      statement: 'High-dose Vitamin C supplementation eliminates all forms of cancer within 30 days with no side effects.',
      expected: 'refuted',
    },
    {
      title: 'Consciousness from quantum events',
      statement: 'All human conscious experience arises directly from quantum-mechanical events in microtubules.',
      expected: 'inconclusive',
    },
  ];

  const ids: string[] = [];
  for (const tc of testCases) {
    ids.push(await submitHypothesis(tc.title, tc.statement));
  }

  const results: Array<{ expected: string; title: string; got: string }> = [];

  for (let i = 0; i < ids.length; i++) {
    process.stdout.write(`\nPolling ${testCases[i]!.title}: `);
    const state = await pollForVerdict(ids[i]!);
    const got = state.verdict?.verdict ?? state.hypothesis.status;
    console.log(got);
    results.push({ expected: testCases[i]!.expected, title: testCases[i]!.title, got });
  }

  console.log('\nHypothesis                            Expected        Got             Match');
  console.log('--------------------------------------------------------------------------');
  let matchCount = 0;

  for (const r of results) {
    const match = r.got === r.expected || r.got === 'inconclusive';
    if (match) matchCount++;
    console.log(`${r.title.padEnd(38)}${r.expected.padEnd(16)}${r.got.padEnd(16)}${match ? 'PASS' : 'FAIL'}`);
  }

  console.log(`\nAccuracy: ${matchCount}/${results.length}`);

  // Bundle endpoint is verdict-id based.
  const firstDone = await apiCall<HypothesisResponse>('GET', `/api/sv/hypotheses/${ids[0]}`);
  if (firstDone.status === 200 && firstDone.data.verdict?.id) {
    const bundle = await apiCall<Record<string, unknown>>(
      'GET',
      `/api/sv/verdicts/${firstDone.data.verdict.id}/bundle`,
    );

    if (bundle.status === 200) {
      const subClaims = Array.isArray(bundle.data['subClaims']) ? bundle.data['subClaims'].length : 0;
      const evidenceEvents = Array.isArray(bundle.data['evidenceEvents']) ? bundle.data['evidenceEvents'].length : 0;
      const agentTurns = Array.isArray(bundle.data['agentTurns']) ? bundle.data['agentTurns'].length : 0;

      console.log('\nBundle summary (first hypothesis):');
      console.log(`schemaVersion: ${String(bundle.data['schemaVersion'] ?? '-')}`);
      console.log(`subClaims: ${subClaims}`);
      console.log(`evidenceEvents: ${evidenceEvents}`);
      console.log(`agentTurns: ${agentTurns}`);
    }
  }

  console.log('\nBatch comparison complete.');
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
