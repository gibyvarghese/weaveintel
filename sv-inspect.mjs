/**
 * Quick Playwright visual inspection of the SV submit view.
 * Run: node sv-inspect.mjs  (from repo root)
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';

const PORT = 3522;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT  = '/tmp/sv-screenshots';
mkdirSync(OUT, { recursive: true });

// ── Start server ──────────────────────────────────────────────────────────────
console.log('▶ Starting server on port', PORT, '…');
const dbPath = join(tmpdir(), `sv-inspect-${Date.now()}.db`);

const srv = spawn('npx', ['tsx', 'deploy/server.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    DATABASE_PATH: dbPath,
    DATABASE_URL: 'postgres://dev:dev@localhost/dev',
    GENEWEAVE_SQLITE_OVERRIDE: '1',
    NODE_ENV: 'test',
    JWT_SECRET: 'sv-inspect-secret-32charslongXXXX',
    PLAYWRIGHT_E2E: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

srv.stdout.on('data', d => {
  const msg = d.toString();
  if (msg.includes('server ready') || msg.includes('Fatal') || msg.includes('Error')) {
    process.stdout.write(`[srv] ${msg}`);
  }
});
srv.stderr.on('data', d => process.stderr.write(`[srv-err] ${d}`));

async function waitForServer(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/me`);
      if (r.status === 401 || r.status === 200) { console.log('✓ Server is up (status', r.status, ')'); return; }
    } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error('Server never became ready');
}

// ── Main ──────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// Capture ALL console messages and JS errors
const consoleMessages = [];
page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => consoleMessages.push(`[JS-ERROR] ${err.message}`));

try {
  await waitForServer();

  const EMAIL = `inspector-${Date.now()}@weaveintel.dev`;
  const PASS  = 'Str0ng!Pass99';

  // Register + login
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Inspector', email: EMAIL, password: PASS }),
  });
  const loginRes = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASS },
  });
  console.log('Login:', loginRes.status());

  await page.goto(BASE + '/');
  await page.waitForSelector('.workspace-nav', { timeout: 12000 });
  await page.screenshot({ path: `${OUT}/00-dashboard.png` });
  console.log('✓ 00-dashboard.png (dashboard)');

  // Open SV
  const svBtn = page.getByRole('button', { name: /Validation/i }).first();
  await svBtn.waitFor({ timeout: 5000 });
  await svBtn.click();
  await sleep(800);

  await page.screenshot({ path: `${OUT}/01-sv-above-fold.png` });
  console.log('✓ 01-sv-above-fold.png');

  await page.screenshot({ path: `${OUT}/02-sv-fullpage.png`, fullPage: true });
  console.log('✓ 02-sv-fullpage.png');

  // Dump console log so far
  console.log('\n── Console messages (up to SV load) ──────────────────────');
  consoleMessages.slice(-20).forEach(m => console.log(m));
  consoleMessages.length = 0;

  // Check actual style attribute on the outer wrapper
  const styleAttrCheck = await page.evaluate(() => {
    const divs = document.querySelectorAll('div');
    const results = [];
    for (const d of divs) {
      const sa = d.getAttribute('style');
      if (sa && sa.includes('max-width')) results.push({ style: sa.slice(0, 80), w: d.getBoundingClientRect().width });
      if (results.length >= 5) break;
    }
    return results;
  });
  console.log('\n── Elements with max-width in style attr ───────────────────');
  console.log(JSON.stringify(styleAttrCheck, null, 2));

  // Diagnostics
  const diag = await page.evaluate(() => {
    function info(el) {
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      const r  = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, maxW: cs.maxWidth };
    }
    const dash  = document.querySelector('.dash-view');
    const h2    = document.querySelector('h2');
    const input = document.querySelector('input');
    const ta    = document.querySelector('textarea');
    const grid  = document.querySelector('[style*="grid-template-columns"]');
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dash:  info(dash),
      h2:    { text: h2?.textContent?.trim(), ...info(h2) },
      input: info(input),
      textarea: info(ta),
      grid:  info(grid),
      templateCardCount: document.querySelectorAll('[style*="minmax(160px"]').length,
    };
  });
  console.log('\n── Layout diagnostics ──────────────────────────────────────');
  console.log(JSON.stringify(diag, null, 2));

  // Click "Clinical Trial" template card
  const clinicalCard = page.locator('text=Clinical Trial').first();
  if (await clinicalCard.count() > 0) {
    await clinicalCard.click();
    await sleep(400);
    await page.screenshot({ path: `${OUT}/03-clinical-template.png` });
    console.log('✓ 03-clinical-template.png (after Clinical Trial template click)');

    const vals = await page.evaluate(() => ({
      title:     document.querySelector('input')?.value,
      statement: document.querySelector('textarea')?.value?.slice(0, 80),
    }));
    console.log('  title:',     vals.title?.slice(0, 60));
    console.log('  statement:', vals.statement);
  }

  // Add domain tags
  for (const tag of ['biology', 'chemistry', 'mathematics']) {
    const btn = page.locator(`button:has-text("${tag}")`).first();
    if (await btn.count() > 0) { await btn.click(); await sleep(120); }
  }
  await page.screenshot({ path: `${OUT}/04-with-tags.png` });
  console.log('✓ 04-with-tags.png (after adding 3 domain tags)');

  // Chip diagnostics
  const chips = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[style*="border-radius:999px"]')).map(c => ({
      text: c.textContent?.trim().slice(0, 20),
      w: Math.round(c.getBoundingClientRect().width),
      display: window.getComputedStyle(c).display,
    }))
  );
  console.log('\n── Chips/pills ─────────────────────────────────────────────');
  console.log(JSON.stringify(chips, null, 2));

  // Laptop viewport
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: `${OUT}/05-1280x800.png` });
  console.log('✓ 05-1280x800.png');

  // Smaller viewport
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: `${OUT}/06-1024x768.png`, fullPage: true });
  console.log('✓ 06-1024x768.png');

  // Dump final console messages
  console.log('\n── All console messages ─────────────────────────────────────');
  consoleMessages.forEach(m => console.log(m));

  console.log(`\n✓ All screenshots in ${OUT}/`);

} catch (e) {
  console.error('INSPECTION ERROR:', e);
} finally {
  await browser.close();
  srv.kill();
  process.exit(0);
}
