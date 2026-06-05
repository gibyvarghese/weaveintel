#!/usr/bin/env node
// scripts/e2e-phaseD-tool-requires.mjs
//
// Phase D (Tool capability requires) — prove that:
//   1. The `tool_catalog.requires` column exists (M28 migration applied).
//   2. `syncToolCatalog` populates it from each tool's `schema.requires`
//      (web_search → ['runtime.net.egress','runtime.secrets'], etc.).
//   3. GET /api/admin/tool-catalog surfaces the column to operators.
//   4. The DB rows match the API response (no drift).
//
// Usage: zsh> set +H && node scripts/e2e-phaseD-tool-requires.mjs
import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phaseD_${ts}@example.com`;
const password = 'P@ssw0rd123';

console.log(`\n=== Phase D E2E (tool requires:[...]) — ${BASE} | DB=${DB_PATH} ===\n`);

// 1. Register + promote + login
console.log('1. Register + promote + login');
await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phaseD' } });
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '')
  .split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string', 'csrf token present');

// 2. DB direct: verify M28 column + populated rows
console.log('\n2. DB verify: tool_catalog.requires column populated by syncToolCatalog');
const dbRows = execSync(
  `sqlite3 ${DB_PATH} "SELECT tool_key, requires FROM tool_catalog WHERE requires IS NOT NULL ORDER BY tool_key;"`,
).toString().trim().split('\n').filter(Boolean);
ok(dbRows.length >= 5, `at least 5 tools have requires set (got ${dbRows.length})`);
const dbMap = Object.fromEntries(dbRows.map(line => {
  const [k, v] = line.split('|');
  return [k, JSON.parse(v)];
}));
ok(
  Array.isArray(dbMap['web_search']) && dbMap['web_search'].includes('runtime.net.egress') && dbMap['web_search'].includes('runtime.secrets'),
  `web_search requires=${JSON.stringify(dbMap['web_search'])}`,
);
ok(
  Array.isArray(dbMap['pubmed_search']) && dbMap['pubmed_search'].includes('runtime.secrets'),
  `pubmed_search requires=${JSON.stringify(dbMap['pubmed_search'])}`,
);
ok(
  Array.isArray(dbMap['arxiv_search']) && dbMap['arxiv_search'].includes('runtime.net.egress') && !dbMap['arxiv_search'].includes('runtime.secrets'),
  `arxiv_search requires=${JSON.stringify(dbMap['arxiv_search'])} (egress only, no secrets)`,
);

// 3. API: GET /api/admin/tool-catalog and verify the requires field is wired through
console.log('\n3. GET /api/admin/tool-catalog (admin) — verify requires surfaces in API');
const list = await jfetch('GET', '/api/admin/tool-catalog', { cookie, csrf });
ok(list.status === 200, `list status=${list.status}`);
const tools = list.body?.tools ?? [];
ok(Array.isArray(tools) && tools.length > 5, `tools.length=${tools.length}`);
const apiWebSearch = tools.find(t => t.tool_key === 'web_search');
ok(apiWebSearch, 'web_search row in API response');
ok(typeof apiWebSearch.requires === 'string' && apiWebSearch.requires.length > 0, `web_search.requires (raw)=${apiWebSearch.requires}`);
const apiWebSearchParsed = JSON.parse(apiWebSearch.requires);
ok(
  apiWebSearchParsed.includes('runtime.net.egress') && apiWebSearchParsed.includes('runtime.secrets'),
  `API web_search requires=${JSON.stringify(apiWebSearchParsed)}`,
);

// 4. API/DB consistency: every API row's requires matches the DB
console.log('\n4. API ↔ DB consistency check on requires field');
let mismatches = 0;
for (const t of tools) {
  if (!t.tool_key) continue;
  const dbVal = dbMap[t.tool_key] ? JSON.stringify(dbMap[t.tool_key]) : null;
  if (dbVal !== (t.requires ?? null)) mismatches++;
}
ok(mismatches === 0, `API rows match DB requires for all tools (mismatches=${mismatches})`);

// 5. Negative: pure utility tools (calculator) have NULL requires
console.log('\n5. Pure-utility tools have NULL requires');
const apiCalc = tools.find(t => t.tool_key === 'calculator');
ok(apiCalc !== undefined, 'calculator row present');
ok(apiCalc.requires === null || apiCalc.requires === undefined, `calculator.requires=${apiCalc.requires}`);

console.log(`\n✅ Phase D e2e: ${ok.count()}/${ok.count()} assertions passed.\n`);
