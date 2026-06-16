/**
 * Realtime voice pipeline — live Playwright E2E
 *
 * Tests the actual browser → server WS → OpenAI Realtime flow.
 * Requires OPENAI_API_KEY in .env with GA Realtime API access.
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const EMAIL    = 'realtime-live@weaveintel.dev';

async function loginOrRegister(page: Page) {
  await page.goto('/');
  if (await page.locator('.workspace-nav').isVisible({ timeout: 2_000 }).catch(() => false)) return;

  let res = await page.request.post('/api/auth/login', {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (res.status() !== 200) {
    await page.request.post('/api/auth/register', {
      data: { name: 'Realtime Live', email: EMAIL, password: PASSWORD },
    });
    res = await page.request.post('/api/auth/login', {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(res.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 10_000 });
}

async function getCsrf(page: Page): Promise<string> {
  const r = await page.request.get('/api/auth/me');
  if (!r.ok()) return '';
  return ((await r.json()) as { csrfToken?: string }).csrfToken ?? '';
}

async function apiSaveConfig(page: Page, patch: Record<string, unknown>) {
  const csrf = await getCsrf(page);
  const r = await page.request.post('/api/voice/config', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: patch,
  });
  expect(r.status()).toBe(200);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Realtime voice — live connection', () => {

  test('proxy connects to OpenAI GA Realtime and gets realtime_ready', async ({ page }) => {
    await loginOrRegister(page);
    await apiSaveConfig(page, { pipelineMode: 'realtime', realtimeModel: 'gpt-realtime-2' });

    // Create a voice session
    const csrf = await getCsrf(page);
    const sessionRes = await page.request.post('/api/voice/sessions', {
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      data: {},
    });
    expect(sessionRes.status()).toBe(201);
    const { sessionId } = await sessionRes.json() as { sessionId: string };

    // Connect to the REALTIME endpoint from within the browser (cookies are sent automatically)
    const messages: string[] = await page.evaluate((sid: string) => {
      return new Promise<string[]>((resolve) => {
        const msgs: string[] = [];
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/api/voice/sessions/${sid}/realtime`);
        ws.onmessage = (ev) => { msgs.push(ev.data as string); };
        ws.onerror   = ()   => { msgs.push('__ws_error__'); };
        ws.onclose   = (ev) => { msgs.push(`__ws_close_${ev.code}__`); };
        // Wait up to 6 seconds for OpenAI to respond
        setTimeout(() => { ws.close(); resolve(msgs); }, 6000);
      });
    }, sessionId);

    const parsed = messages.map((m) => {
      try { return JSON.parse(m) as Record<string, unknown>; }
      catch { return { type: m }; }
    });

    console.log('[realtime-live] Events received:', parsed.map((e) => e['type']));

    // Log any errors with full detail for diagnosis
    const errors = parsed.filter((e) => e['type'] === 'error');
    if (errors.length) {
      console.log('[realtime-live] Error details:', JSON.stringify(errors, null, 2));
    }

    // If we got fallbackToChained it means OpenAI rejected — surface the message
    const fallback = parsed.find((e) => e['fallbackToChained']);
    if (fallback) {
      throw new Error(`OpenAI Realtime rejected connection: ${fallback['message'] as string}`);
    }

    // The proxy must forward realtime_ready (sent after OpenAI session.created + session.updated)
    expect(parsed.map((e) => e['type'])).toContain('realtime_ready');

    await page.request.delete(`/api/voice/sessions/${sessionId}`, {
      headers: { 'X-CSRF-Token': csrf },
    });
  });

  test('mic button shows voice bar and stays visible in realtime mode', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);

    await loginOrRegister(page);
    await apiSaveConfig(page, { pipelineMode: 'realtime', realtimeModel: 'gpt-realtime-2' });

    await page.reload();
    await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 10_000 });

    // Intercept browser console to capture voice-agent log lines
    const consoleLogs: string[] = [];
    page.on('console', (msg) => { consoleLogs.push(`[${msg.type()}] ${msg.text()}`); });
    page.on('pageerror', (err) => { consoleLogs.push(`[pageerror] ${err.message}`); });

    const micBtn = page.locator('.voice-agent-btn');
    await expect(micBtn).toBeVisible({ timeout: 5_000 });
    await micBtn.click();

    await expect(page.locator('.voice-bar')).toBeVisible({ timeout: 10_000 });

    // Poll status every 500ms for 12 seconds so we can see when/if it disappears
    const snapshots: { ms: number; visible: boolean; label: string }[] = [];
    const startMs = Date.now();
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(500);
      const visible = await page.locator('.voice-bar').isVisible().catch(() => false);
      const label   = await page.locator('#va-label').textContent().catch(() => '');
      snapshots.push({ ms: Date.now() - startMs, visible, label: label?.trim() ?? '' });
      if (!visible) break; // stop early if it disappeared
    }

    console.log('[realtime-live] Voice bar timeline:');
    snapshots.forEach((s) => console.log(`  ${s.ms}ms: visible=${s.visible} status="${s.label}"`));
    if (consoleLogs.length) {
      console.log('[realtime-live] Browser console:', consoleLogs.slice(-20).join('\n'));
    }

    await page.screenshot({ path: 'test-results/realtime-mic-state.png', fullPage: false });

    const lastSnapshot = snapshots.at(-1)!;
    expect(lastSnapshot.visible, `Voice bar disappeared at ${lastSnapshot.ms}ms with status "${lastSnapshot.label}"`).toBe(true);
  });

});
