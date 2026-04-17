import { test, expect } from '@playwright/test';

const PROMPT = `Analyze this mini dataset and give me key insights:
Month,Revenue,Cost
Jan,120000,90000
Feb,150000,98000
Mar,110000,87000
Apr,175000,120000

Please compute profit per month, profit margin %, identify best/worst month, and call out any anomaly.`;

test('chat ui streaming behavior for steps and thinking cards', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');

  const email = `pw.chat.${Date.now()}@example.com`;
  const password = 'Passw0rd!234';

  const newChatBtn = page.getByRole('button', { name: '+ New Chat' });

  // Session can already exist from prior local runs; register only when needed.
  if (!(await newChatBtn.isVisible().catch(() => false))) {
    await page.getByText('Register').click();
    await page.locator('#auth-name').fill('Playwright Chat');
    await page.locator('#auth-email').fill(email);
    await page.locator('#auth-pass').fill(password);
    await page.getByRole('button', { name: 'Create Account' }).click();
  }

  await expect(newChatBtn).toBeVisible();

  // Create a chat first; settings only persist when a current chat exists.
  await newChatBtn.click();
  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const chatsRes = await fetch('/api/chats', { credentials: 'same-origin' });
      const chatsJson: any = await chatsRes.json();
      return (chatsJson?.chats ?? []).length;
    });
  }, { timeout: 10_000 }).toBeGreaterThan(0);

  // Use UI settings to switch to Supervisor mode.
  const aiSettingsBtn = page.locator('button[title="AI Settings"]');
  await expect(aiSettingsBtn).toBeVisible();
  await aiSettingsBtn.click();
  const supervisorCard = page.locator('.mode-card').filter({ hasText: 'Supervisor' }).first();
  await expect(supervisorCard).toBeVisible();
  await supervisorCard.click();
  await expect(supervisorCard).toHaveClass(/selected/);
  await page.mouse.click(8, 8);

  // Verify current chat settings persisted as supervisor mode.
  const persistedMode = await page.evaluate(async () => {
    const chatsRes = await fetch('/api/chats', { credentials: 'same-origin' });
    const chatsJson: any = await chatsRes.json();
    const chats = chatsJson?.chats ?? [];
    if (!chats.length) return null;
    const chatId = chats[0].id;
    const settingsRes = await fetch(`/api/chats/${chatId}/settings`, { credentials: 'same-origin' });
    const settingsJson: any = await settingsRes.json();
    return settingsJson?.settings?.mode ?? null;
  });
  expect(persistedMode).toBe('supervisor');

  const textarea = page.locator('textarea[placeholder="Type a message..."]');
  await expect(textarea).toBeVisible();
  await textarea.fill(PROMPT);

  const sendBtn = page.getByRole('button', { name: 'Send' });
  await sendBtn.click();

  // Wait for the assistant turn to begin and process card to appear.
  await expect(page.locator('.msg.assistant').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.msg.assistant .process-card').first()).toBeVisible({ timeout: 90_000 });

  // Track process card behavior while streaming.
  const timeline: Array<{ tickMs: number; processCards: number; expandedCards: number; liveThoughtChars: number }> = [];
  const start = Date.now();

  for (let i = 0; i < 8; i++) {
    const processCards = await page.locator('.msg.assistant .process-card').count();
    const expandedCards = await page.locator('.msg.assistant .process-card .process-body-wrap.expanded').count();
    const liveThought = await page.locator('.msg.assistant .process-card .live-thought .txt').first().textContent().catch(() => '');
    timeline.push({
      tickMs: Date.now() - start,
      processCards,
      expandedCards,
      liveThoughtChars: (liveThought || '').trim().length,
    });
    await page.waitForTimeout(500);
  }

  // Final response should appear and process details should auto-collapse.
  await expect(page.locator('.msg.assistant .bubble').first()).toBeVisible({ timeout: 90_000 });
  const processToggle = page.locator('.msg.assistant .process-card .process-toggle').first();
  await expect(processToggle).toHaveAttribute('aria-expanded', 'false', { timeout: 60_000 });
  await expect(page.locator('.msg.assistant .process-card .process-summary').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.msg.assistant .process-card')).toHaveCount(1);
  await expect(page.locator('.msg.assistant .process-card .summary-chip').first()).toBeVisible();
  await expect(page.locator('.msg.assistant .step-card.skill')).toHaveCount(0);
  await expect(page.locator('.msg.assistant .process-card [role="status"][aria-live="polite"]')).toHaveCount(1);

  // Expand on demand via keyboard and verify timeline remains inspectable.
  await processToggle.focus();
  await page.keyboard.press('Enter');
  await expect(processToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.msg.assistant .process-card .process-body-wrap.expanded')).toHaveCount(1);
  await expect.poll(async () => {
    return await page.locator('.msg.assistant .process-card .timeline-item').count();
  }, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator('.msg.assistant .process-card .skill-list .skill-item').first()).toBeVisible();
  await expect(page.locator('.msg.assistant .process-card .validation-list .validation-item').first()).toBeVisible();
  await expect(page.locator('.msg.assistant .process-card .live-thought .txt').first()).not.toHaveText('No thought trace captured.');

  const detailToggle = page.locator('.msg.assistant .process-card .timeline-item .detail-toggle').first();
  await expect(detailToggle).toBeVisible();
  await detailToggle.focus();
  await page.keyboard.press('Space');
  await expect(detailToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.msg.assistant .process-card .timeline-item .t-raw').first()).toBeVisible();

  const allProcessHeaders = await page
    .locator('.msg.assistant .process-card .timeline-item .t-h span:first-child')
    .allTextContents();

  const normalizedHeaders = allProcessHeaders
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const metrics = {
    persistedMode,
    timeline,
    final: {
      processCards: await page.locator('.msg.assistant .process-card').count(),
      expandedProcessBodies: await page.locator('.msg.assistant .process-card .process-body-wrap.expanded').count(),
      thoughtRows: await page.locator('.msg.assistant .process-card .live-thought').count(),
      timelineRows: await page.locator('.msg.assistant .process-card .timeline-item').count(),
      skillRows: await page.locator('.msg.assistant .process-card .skill-list .skill-item').count(),
      validationRows: await page.locator('.msg.assistant .process-card .validation-list .validation-item').count(),
      detailToggles: await page.locator('.msg.assistant .process-card .timeline-item .detail-toggle').count(),
      rawBlocks: await page.locator('.msg.assistant .process-card .timeline-item .t-raw').count(),
      summaryChips: await page.locator('.msg.assistant .process-card .summary-chip').allTextContents(),
      headerCount: normalizedHeaders.length,
      uniqueHeaders: [...new Set(normalizedHeaders)],
      headers: normalizedHeaders,
    },
    afterScrollTop: {
      processCards: 0,
      expandedProcessBodies: 0,
      timelineRows: 0,
      headers: [] as string[],
    },
  };

  // Scroll up to inspect early cards that may appear before final response renders.
  await page.locator('.messages').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(400);

  metrics.afterScrollTop.processCards = await page.locator('.msg.assistant .process-card').count();
  metrics.afterScrollTop.expandedProcessBodies = await page.locator('.msg.assistant .process-card .process-body-wrap.expanded').count();
  metrics.afterScrollTop.timelineRows = await page.locator('.msg.assistant .process-card .timeline-item').count();
  metrics.afterScrollTop.headers = (await page
    .locator('.msg.assistant .process-card .timeline-item .t-h span:first-child')
    .allTextContents()).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

  // eslint-disable-next-line no-console
  console.log('PW_CHAT_UI_METRICS', JSON.stringify(metrics));

  await page.screenshot({ path: 'test-results/chat-ui-skills-steps.png', fullPage: true });
});
