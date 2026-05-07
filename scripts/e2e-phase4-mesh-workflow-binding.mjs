import { execSync } from 'node:child_process';
const BASE = 'http://localhost:3500';
let cookie = '', csrf = '';
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = res.headers.get('set-cookie');
  if (sc) { const m = sc.match(/gw_token=([^;]+)/); if (m) cookie = `gw_token=${m[1]}`; }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data };
}
const email = `phase4-${Date.now()}@example.com`;
const reg = await api('POST', '/api/auth/register', { name: 'P4', email, password: 'Str0ng!Pass99' });
console.log('register:', reg.status); csrf = reg.data.csrfToken || '';
execSync(`sqlite3 ./geneweave.db "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await api('POST', '/api/auth/login', { email, password: 'Str0ng!Pass99' });
console.log('login:', login.status); csrf = login.data.csrfToken || csrf;

const wfB = await api('POST', '/api/admin/workflows', {
  name: 'Send Receipt (E2E)', version: '1.0', entry_step_id: 's1',
  steps: [{ id: 's1', name: 'noop', type: 'deterministic', handler: 'noop' }]
});
const wfBid = wfB.data.workflow.id;
console.log('wfB:', wfB.status, wfBid);

const kindStr = `order.fulfilled.e2e.${Date.now()}`;
const wfA = await api('POST', '/api/admin/workflows', {
  name: 'Fulfill Order (E2E)', version: '1.0', entry_step_id: 's1',
  steps: [{ id: 's1', name: 'noop', type: 'deterministic', handler: 'noop' }],
  output_contract: { kind: kindStr, bodyMap: { orderId: 'orderId', amount: 'amount' }, metadata: { source: 'e2e' } }
});
const wfAid = wfA.data.workflow.id;
console.log('wfA:', wfA.status, wfAid, 'metadata=', wfA.data.workflow?.metadata);

const trig = await api('POST', '/api/admin/triggers', {
  key: `trig-${Date.now()}`, enabled: true,
  source_kind: 'contract_emitted', source_config: {},
  filter_expr: { '==': [{ var: 'payload.kind' }, kindStr] },
  target_kind: 'workflow', target_config: { workflowDefId: wfBid },
  input_map: { orderId: 'payload.body.orderId' }
});
console.log('trigger:', trig.status, trig.data?.id);

const run = await api('POST', `/api/admin/workflows/${wfAid}/run`, { variables: { orderId: 'O-E2E-1', amount: 42.5 } });
console.log('wf-run:', run.status, 'status=', run.data.run?.status);

await new Promise(r => setTimeout(r, 1200));
const mc = await api('GET', `/api/admin/mesh-contracts?kind=${kindStr}&limit=5`);
console.log('mesh-contracts:', mc.status, 'count=', mc.data.contracts?.length);
console.log('  first:', JSON.stringify(mc.data.contracts?.[0]));

const invs = await api('GET', `/api/admin/trigger-invocations?source_kind=contract_emitted&limit=10`);
console.log('invocations:', invs.status, 'count=', invs.data.invocations?.length);
console.log('  first:', JSON.stringify(invs.data.invocations?.[0]));
