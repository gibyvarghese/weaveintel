import { test, expect, type Page } from '@playwright/test';

function uniqueEmail() {
  return `pw-grounding-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@weaveintel.dev`;
}

const PASSWORD = 'Str0ng!Pass99';

async function registerAndEnter(page: Page, email?: string) {
  const em = email ?? uniqueEmail();
  await page.goto('/');
  const toggle = page.locator('a', { hasText: 'Register' });
  if (await toggle.isVisible({ timeout: 2000 }).catch(() => false)) await toggle.click();
  await page.locator('#auth-name').fill('Playwright Grounding User');
  await page.locator('#auth-email').fill(em);
  await page.locator('#auth-pass').fill(PASSWORD);
  await page.locator('button', { hasText: 'Create Account' }).click();
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10_000 });
}

test.describe('Grounding Chat UI', () => {
  test('renders post-check grounding and guardrail warnings in the assistant response corner', async ({ page }) => {
    await registerAndEnter(page);

    await page.route('**/api/chats/*/messages', async (route) => {
      const body = [
        'data: ' + JSON.stringify({ type: 'text', text: 'BANANA' }),
        'data: ' + JSON.stringify({
          type: 'cognitive',
          confidence: 0.31,
          decision: 'warn',
          riskLevel: 'low',
          checks: [
            {
              guardrailId: 'guard-cog-post-grounding',
              decision: 'warn',
              explanation: 'Low grounding overlap with user query. Consider adding references, assumptions, or explicit uncertainty.',
              confidence: 0.1,
            },
            {
              guardrailId: 'guard-cog-post-confidence',
              decision: 'warn',
              explanation: 'Post-check confidence 31% (risk=low).',
              confidence: 0.31,
            },
          ],
        }),
        'data: ' + JSON.stringify({ type: 'guardrail', decision: 'warn', reason: 'Low grounding overlap detected.' }),
        'data: ' + JSON.stringify({ type: 'done', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }, cost: 0, latencyMs: 12 }),
        '',
      ].join('\n');

      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body,
      });
    });

    await page.locator('textarea').fill('What is the capital of France?');
    await page.locator('button.send-btn').click({ force: true });

    await expect(page.locator('.msg.assistant .bubble')).toContainText('BANANA', { timeout: 15_000 });
    await expect(page.locator('.msg.assistant .resp-corner .resp-ind.warn')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('.msg.assistant .resp-ind[title*="Cognitive decision: warn"][title*="Low grounding overlap"]')).toBeVisible();
    await expect(page.locator('.msg.assistant .resp-ind[title*="Guardrail: warn"]')).toBeVisible();
  });
});