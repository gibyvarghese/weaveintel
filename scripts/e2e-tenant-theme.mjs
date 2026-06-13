// E2E: per-tenant configurable design tokens.
//
// Verifies the full DB-driven path end to end:
//   1. admin PUT /api/admin/tenant-theme         (global brand override)
//   2. GET  /api/me/theme                          round-trips for the caller
//   3. the global tenant_configs row still has its `limits` key
//      (setThemeInOverrides preserved siblings — no clobber)
//   4. admin PUT /api/admin/tenant-theme/:tenantId (per-tenant override)
//      merges over the platform base (tenant accent wins, platform radii inherit)
//   5. clearing with an empty body removes only the `theme` key
//   6. client-side WCAG-AA gate (@geneweave/tokens applyTenantTheme) degrades a
//      contrast-breaking override instead of shipping it
//
// Self-contained: promotes the test user to platform_admin for the run, then
// restores the original persona and clears any theme it wrote.
import { execSync } from 'node:child_process';
import { applyTenantTheme, themes } from '@geneweave/tokens';

const BASE = process.env.BASE ?? 'http://localhost:3500';
const DB = process.env.DB ?? './geneweave.db';
const EMAIL = process.env.EMAIL ?? 'tester@geneweave.local';
const PASS = process.env.PASS ?? 'Testpass123!';
const TENANT = process.env.TENANT ?? 'trial';

const sql = (q) => execSync(`sqlite3 ${DB} ${JSON.stringify(q)}`).toString().trim();

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const originalPersona = sql(`SELECT persona FROM users WHERE email='${EMAIL}';`) || 'tenant_user';
  sql(`UPDATE users SET persona='platform_admin' WHERE email='${EMAIL}';`);

  try {
    // ── auth ──────────────────────────────────────────────────────────────
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
    const login = await loginRes.json();
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
    if (!cookie) throw new Error('no session cookie');
    const auth = { Cookie: cookie, 'X-CSRF-Token': login.csrfToken, 'Content-Type': 'application/json' };

    const getJson = async (path, init = {}) => {
      const r = await fetch(`${BASE}${path}`, { headers: auth, ...init });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: r.status, body };
    };

    // ── 1. set the platform (global) brand override ─────────────────────────
    console.log('\n[1] PUT /api/admin/tenant-theme (global)');
    const put1 = await getJson('/api/admin/tenant-theme', {
      method: 'PUT',
      body: JSON.stringify({ colors: { accent: '#1FB6A5' }, radii: { md: 14 } }),
    });
    assert(put1.status === 200, `global PUT ok (${put1.status})`);
    assert(put1.body.platformOverride?.colors?.accent === '#1FB6A5', 'global override echoed');

    // ── 2. round-trip via /api/me/theme ─────────────────────────────────────
    console.log('\n[2] GET /api/me/theme');
    const me = await getJson('/api/me/theme');
    assert(me.status === 200, `me/theme ok (${me.status})`);
    assert(me.body.theme?.colors?.accent === '#1FB6A5', 'caller sees the platform accent');
    assert(me.body.theme?.radii?.md === 14, 'caller sees the platform radius');

    // ── 3. limits key preserved (no clobber) ────────────────────────────────
    console.log('\n[3] GET /api/admin/platform-limits (sibling key preserved)');
    const limits = await getJson('/api/admin/platform-limits');
    assert(limits.body.platformOverrides?.chat_max_steps === 20, 'limits.chat_max_steps still 20 after theme write');

    // ── 4. per-tenant override merges over platform base ────────────────────
    console.log(`\n[4] PUT /api/admin/tenant-theme/${TENANT} (tenant override)`);
    const put2 = await getJson(`/api/admin/tenant-theme/${TENANT}`, {
      method: 'PUT',
      body: JSON.stringify({ colors: { accent: '#FF0000' } }),
    });
    assert(put2.status === 200, `tenant PUT ok (${put2.status})`);
    assert(put2.body.effective?.colors?.accent === '#FF0000', 'tenant accent wins over platform');
    assert(put2.body.effective?.radii?.md === 14, 'tenant inherits platform radius');

    // ── 5. clear removes only the theme key ─────────────────────────────────
    console.log('\n[5] PUT /api/admin/tenant-theme (clear via empty body)');
    const clear = await getJson('/api/admin/tenant-theme', { method: 'PUT', body: '{}' });
    assert(clear.status === 200, `clear ok (${clear.status})`);
    assert(clear.body.platformOverride === null, 'global override cleared');
    const meAfter = await getJson('/api/me/theme');
    assert(meAfter.body.theme === null, 'me/theme is null after clear');
    const limitsAfter = await getJson('/api/admin/platform-limits');
    assert(limitsAfter.body.platformOverrides?.chat_max_steps === 20, 'limits survive theme clear');

    // ── 6. client-side WCAG-AA gate degrades a bad override ─────────────────
    console.log('\n[6] @geneweave/tokens applyTenantTheme AA gate');
    const ok = applyTenantTheme(themes.light, { colors: { accent: '#0E7C66' } });
    assert(ok.degraded === false, 'a sane override is accepted (not degraded)');
    // `text` on a light surface set to near-white fails AA → must degrade.
    const bad = applyTenantTheme(themes.light, { colors: { text: '#FAFAFA' } });
    assert(bad.degraded === true, 'a contrast-breaking override is degraded to base');

    console.log('\nALL ASSERTIONS PASSED ✅');
  } finally {
    // cleanup: clear the tenant override we wrote, restore persona
    try {
      const loginRes = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASS }),
      });
      if (loginRes.ok) {
        const login = await loginRes.json();
        const cookie = (loginRes.headers.get('set-cookie') ?? '').split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
        await fetch(`${BASE}/api/admin/tenant-theme/${TENANT}`, {
          method: 'PUT',
          headers: { Cookie: cookie, 'X-CSRF-Token': login.csrfToken, 'Content-Type': 'application/json' },
          body: '{}',
        });
      }
    } catch { /* best-effort */ }
    sql(`UPDATE users SET persona='${originalPersona}' WHERE email='${EMAIL}';`);
    console.log(`\n(cleanup) restored persona to '${originalPersona}', cleared ${TENANT} theme`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
