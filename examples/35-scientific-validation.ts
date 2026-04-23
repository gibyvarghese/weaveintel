/**
 * Example 35 — Scientific Validation (SV) Feature
 *
 * Demonstrates the end-to-end Scientific Validation workflow via the
 * geneWeave HTTP API:
 *
 *  1. Submit a hypothesis for validation
 *  2. Stream evidence events via SSE
 *  3. Stream agent dialogue via SSE
 *  4. Wait for the final verdict
 *  5. Download the full evidence bundle
 *  6. Cancel an in-progress run (idempotent)
 *  7. Reproduce (re-run) a completed hypothesis
 *
 * The SV feature uses a multi-agent architecture:
 *  - Supervisor agent decomposes the hypothesis into sub-claims
 *  - Literature agent searches for supporting publications
 *  - Statistical agent assesses the statistical validity of evidence
 *  - Mathematical agent formalises the claim and checks equations
 *  - Simulation agent runs computational experiments
 *  - Adversarial agent attempts to falsify the hypothesis
 *  - Synthesis agent weighs evidence and emits the verdict
 *
 * Prerequisites:
 *  - geneWeave server running at BASE_URL (default: http://localhost:3500)
 *  - An authenticated session via API_EMAIL / API_PASSWORD env vars
 *  - At least one model provider configured (OpenAI or Anthropic)
 *
 * Environment variables:
 *  API_URL       Base URL of the server      (default: http://localhost:3500)
 *  API_EMAIL     Login email                 (default: admin@geneweave.ai)
 *  API_PASSWORD  Login password              (default: admin123)
 */
export {};

const BASE_URL = process.env['API_URL'] ?? 'http://localhost:3500';
const EMAIL = process.env['API_EMAIL'] ?? 'admin@geneweave.ai';
const PASSWORD = process.env['API_PASSWORD'] ?? 'admin123';

// ── HTTP client ──────────────────────────────────────────────────────────────

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

  let data: T;
  const text = await res.text();
  try { data = JSON.parse(text) as T; } catch { data = text as unknown as T; }
  return { status: res.status, data };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function login() {
  console.log('→ Fetching CSRF token…');
  const { data: initData } = await apiCall<{ csrfToken?: string }>('GET', '/api/init');
  _csrf = (initData as any).csrfToken ?? '';

  console.log('→ Logging in…');
  const { status, data } = await apiCall<{ token?: string }>('POST', '/api/auth/login', {
    email: EMAIL,
    password: PASSWORD,
  });
  if (status !== 200) throw new Error(`Login failed: ${JSON.stringify(data)}`);
  console.log('✓ Authenticated\n');
}

// ── Step 1: Submit a hypothesis ───────────────────────────────────────────────

interface HypothesisCreated {
  id: string;
  status: string;
  traceId: string;
  contractId: string;
}

async function submitHypothesis(): Promise<string> {
  console.log('── Step 1: Submit hypothesis ─────────────────────────────────');
  const { status, data } = await apiCall<HypothesisCreated>('POST', '/api/sv/hypotheses', {
    title: 'Aspirin reduces secondary MI risk',
    statement:
      'Low-dose aspirin (75–100 mg/day) reduces the rate of recurrent non-fatal myocardial infarction ' +
      'by approximately 25% in patients with established cardiovascular disease compared to placebo, ' +
      'as supported by the Antithrombotic Trialists\' Collaboration meta-analysis.',
    domainTags: ['cardiology', 'pharmacology', 'secondary-prevention'],
  });

  if (status !== 201) throw new Error(`Expected 201, got ${status}: ${JSON.stringify(data)}`);
  console.log(`✓ Hypothesis submitted: id=${data.id} status=${data.status}`);
  console.log(`  traceId=${data.traceId}  contractId=${data.contractId}\n`);
  return data.id;
}

// ── Step 2: Stream evidence events (SSE) ─────────────────────────────────────

async function streamEvidence(hypothesisId: string, maxMs = 30_000) {
  console.log('── Step 2: Stream evidence events (SSE) ─────────────────────');
  const url = `${BASE_URL}/api/sv/hypotheses/${hypothesisId}/events`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), maxMs);

  const res = await fetch(url, {
    headers: { Cookie: _cookie, Accept: 'text/event-stream' },
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    clearTimeout(timeout);
    console.log(`  ⚠ SSE stream not available (${res.status}) — skipping\n`);
    return;
  }

  let count = 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const ev = JSON.parse(raw) as { agentId?: string; kind?: string; summary?: string };
            console.log(`  [evidence] ${ev.agentId ?? '?'} | ${ev.kind ?? '?'} | ${(ev.summary ?? '').substring(0, 60)}`);
            count++;
            if (count >= 5) { controller.abort(); break; }
          } catch { /* skip malformed */ }
        }
      }
      if (count >= 5) break;
    }
  } catch { /* AbortError is expected */ }

  clearTimeout(timeout);
  console.log(`  (collected ${count} evidence events, stopping early for demo)\n`);
}

// ── Step 3: Poll for verdict ──────────────────────────────────────────────────

interface VerdictShape {
  id: string;
  verdict: string;
  confidenceLo: number;
  confidenceHi: number;
  limitations?: string;
}

interface StatusResponse {
  hypothesis: { id: string; title: string; status: string; createdAt: string };
  verdict: VerdictShape | null;
}

async function pollVerdict(hypothesisId: string, timeoutMs = 300_000): Promise<VerdictShape | null> {
  console.log('── Step 3: Poll for verdict ──────────────────────────────────');
  const terminalStatuses = new Set(['verdict', 'abandoned']);
  const start = Date.now();
  const interval = 6_000;
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 2_000 : interval));
    attempt++;
    const { data } = await apiCall<StatusResponse>('GET', `/api/sv/hypotheses/${hypothesisId}`);
    const { status } = data.hypothesis;
    process.stdout.write(`  [${attempt}] status=${status}\r`);
    if (terminalStatuses.has(status)) {
      console.log(`\n✓ Hypothesis reached terminal status: ${status}\n`);
      return data.verdict;
    }
  }
  console.log('\n  ⚠ Timed out waiting for verdict\n');
  return null;
}

// ── Step 4: Download evidence bundle ─────────────────────────────────────────

interface Bundle {
  schemaVersion: string;
  hypothesis: { title: string; statement: string };
  verdict: VerdictShape;
  subClaims: { id: string; statement: string; claimType: string }[];
  evidenceEvents: { evidenceId: string; kind: string; summary: string; agentId: string }[];
}

async function downloadBundle(verdictId: string) {
  console.log('── Step 4: Download evidence bundle ─────────────────────────');
  const { status, data } = await apiCall<Bundle>('GET', `/api/sv/verdicts/${verdictId}/bundle`);
  if (status !== 200) {
    console.log(`  ⚠ Bundle not available (${status})\n`);
    return;
  }
  console.log(`✓ Bundle downloaded (schemaVersion=${data.schemaVersion})`);
  console.log(`  Sub-claims: ${data.subClaims.length}  Evidence events: ${data.evidenceEvents.length}`);
  console.log(`  Verdict: ${data.verdict.verdict} [${(data.verdict.confidenceLo * 100).toFixed(0)}–${(data.verdict.confidenceHi * 100).toFixed(0)}%]`);
  if (data.verdict.limitations) {
    console.log(`  Limitations: ${data.verdict.limitations.substring(0, 100)}`);
  }
  console.log('');
}

// ── Step 5: Cancel an in-progress run ─────────────────────────────────────────

async function demonstrateCancel() {
  console.log('── Step 5: Cancel demonstration ─────────────────────────────');
  // Submit a new hypothesis and immediately cancel it
  const { status: s1, data: created } = await apiCall<HypothesisCreated>('POST', '/api/sv/hypotheses', {
    title: 'Cancel demo hypothesis',
    statement: 'This hypothesis will be immediately cancelled to demonstrate the cancel endpoint.',
    domainTags: ['demo'],
  });
  if (s1 !== 201) { console.log(`  ⚠ Skipping cancel demo (submit failed ${s1})\n`); return; }

  const { status: s2, data: cancelled } = await apiCall<{ id: string; status: string }>('POST', `/api/sv/hypotheses/${created.id}/cancel`);
  if (s2 === 200) {
    console.log(`✓ Cancelled ${created.id} — new status: ${(cancelled as any).status}\n`);
  } else {
    console.log(`  ⚠ Cancel returned ${s2}: ${JSON.stringify(cancelled)}\n`);
  }
}

// ── Step 6: Reproduce (re-run) ────────────────────────────────────────────────

async function demonstrateReproduce(originalId: string) {
  console.log('── Step 6: Reproduce run ─────────────────────────────────────');
  const { status, data } = await apiCall<{ id: string; originalId: string; status: string; traceId: string }>(
    'POST', `/api/sv/hypotheses/${originalId}/reproduce`,
  );
  if (status !== 201) { console.log(`  ⚠ Reproduce returned ${status}: ${JSON.stringify(data)}\n`); return; }
  console.log(`✓ Reproduction queued`);
  console.log(`  new id=${data.id}  originalId=${data.originalId}  status=${data.status}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Example 35: Scientific Validation ===\n');

  await login();

  // Core workflow
  const hypothesisId = await submitHypothesis();
  await streamEvidence(hypothesisId);

  // Poll for a real verdict (may take a few minutes with real models)
  const verdict = await pollVerdict(hypothesisId, 360_000);
  if (verdict) {
    console.log(`  Verdict: ${verdict.verdict}`);
    console.log(`  Confidence: ${(verdict.confidenceLo * 100).toFixed(0)}–${(verdict.confidenceHi * 100).toFixed(0)}%`);
    await downloadBundle(verdict.id);
  }

  // Auxiliary operations
  await demonstrateCancel();
  await demonstrateReproduce(hypothesisId);

  console.log('=== Done ===\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
