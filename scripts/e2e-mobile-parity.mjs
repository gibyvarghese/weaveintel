// E2E: verify the mobile /api/me/runs path now routes through the full chat
// pipeline (agent mode → tools enabled) so the datetime tool actually fires.
const BASE = process.env.BASE ?? 'http://localhost:3500';
const EMAIL = process.env.EMAIL ?? 'tester@geneweave.local';
const PASS = process.env.PASS ?? 'Testpass123!';

async function main() {
  // 1) Login (cookie session + CSRF token in body).
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
  const login = await loginRes.json();
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  const csrf = login.csrfToken;
  if (!cookie) throw new Error('no session cookie returned');
  const auth = { Cookie: cookie, 'X-CSRF-Token': csrf };

  // 2) Start a mobile run with a stable conversation token + assistant mode.
  const startRes = await fetch(`${BASE}/api/me/runs`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': `e2e-${Date.now()}` },
    body: JSON.stringify({
      surface: 'mobile',
      input: { text: 'What day is it today? Use your tools.' },
      metadata: { chatId: `e2e-conv-${Date.now()}`, options: { mode: process.env.MODE ?? 'assistant' } },
    }),
  });
  if (startRes.status !== 201) throw new Error(`start failed: ${startRes.status} ${await startRes.text()}`);
  const run = await startRes.json();
  const runId = run.id;
  console.log(`run started: ${runId}`);

  // 3) Stream events for up to 60s; collect tool + text.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const evRes = await fetch(`${BASE}/api/me/runs/${runId}/events`, {
    headers: { ...auth, Accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  if (!evRes.ok) throw new Error(`events failed: ${evRes.status}`);

  const reader = evRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const tools = [];
  let text = '';
  let terminal = null;

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let env;
      try { env = JSON.parse(line.slice(line.indexOf(':') + 1).trim()); } catch { continue; }
      const kind = env.kind ?? env.type;
      if (kind === 'tool.invoked') tools.push(`${env.payload?.tool ?? '?'}:invoked`);
      if (kind === 'tool.completed') tools.push(`${env.payload?.tool ?? '?'}:completed`);
      if (kind === 'text.delta') text += env.payload?.delta ?? '';
      if (kind === 'run.completed' || kind === 'run.failed' || kind === 'run.cancelled') {
        terminal = kind;
        break outer;
      }
    }
  }
  clearTimeout(timer);
  ctrl.abort();

  console.log('terminal:', terminal);
  console.log('tools invoked:', tools);
  console.log('text:', text.slice(0, 300));

  const ok = tools.length > 0 && terminal === 'run.completed';
  console.log(ok ? '\nPASS — tools fired in mobile run' : '\nFAIL — no tools / not completed');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
