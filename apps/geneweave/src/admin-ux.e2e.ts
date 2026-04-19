import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Pass99';
const ADMIN_EMAIL = 'pw-e2e-admin@weaveintel.dev';

async function registerAndEnter(page: Page, email?: string) {
  const em = email ?? ADMIN_EMAIL;
  await page.goto('/');

  if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;

  let login = await page.request.post('/api/auth/login', {
    data: { email: em, password: PASSWORD },
  });

  if (login.status() !== 200) {
    const register = await page.request.post('/api/auth/register', {
      data: { name: 'Admin UX User', email: em, password: PASSWORD },
    });
    expect([201, 409]).toContain(register.status());

    login = await page.request.post('/api/auth/login', {
      data: { email: em, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
  }

  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 5000 });
}

async function goAdmin(page: Page) {
  await page.locator('.profile-avatar').click();
  await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
}

test.describe('Admin UX Regression', () => {
  test('tab switch closes editor state', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await page.locator('[data-admin-tab="guardrails"]').first().click();
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();

    await expect(m.locator('.admin-breadcrumbs')).toBeVisible({ timeout: 3000 });
    await expect(m.locator('.admin-list-panel')).toHaveCount(0);
    await expect(m.getByRole('heading', { name: 'New Guardrail' })).toBeVisible({ timeout: 3000 });

    await page.locator('[data-admin-tab="routing"]').first().click();

    await expect(m.locator('.admin-breadcrumbs')).toHaveCount(0);
    await expect(m.getByRole('heading', { name: 'New Guardrail' })).toHaveCount(0);
  });

  test('breadcrumb returns from form to list', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await page.locator('[data-admin-tab="guardrails"]').first().click();

    const editBtn = m.locator('.admin-list-panel button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
    } else {
      await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    }

    await expect(m.locator('.admin-breadcrumbs')).toBeVisible({ timeout: 3000 });
    await expect(m.locator('.admin-list-panel')).toHaveCount(0);
    await m.locator('[data-testid="admin-breadcrumb-back"]').click();
    await expect(m.locator('.admin-breadcrumbs')).toHaveCount(0);
    await expect(m.locator('.admin-list-panel')).toBeVisible({ timeout: 3000 });
  });

  test('prompts opens list first then wizard on edit/new', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await page.locator('[data-admin-tab="prompts"]').first().click();

    await expect(m.locator('.admin-list-panel')).toBeVisible({ timeout: 5000 });
    await expect(m.locator('.prompt-wizard')).toHaveCount(0);

    const editBtn = m.locator('.admin-list-panel button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editBtn.click();
    } else {
      await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    }

    await expect(m.locator('.prompt-wizard')).toBeVisible({ timeout: 5000 });
    await expect(m.locator('.admin-breadcrumbs')).toBeVisible({ timeout: 3000 });
  });

  test('insert marker inserts at cursor without overwriting template text', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);

    const m = page.locator('.main');
    await page.locator('[data-admin-tab="prompts"]').first().click();
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await expect(m.locator('.prompt-wizard')).toBeVisible({ timeout: 5000 });

    const options = m.locator('[data-testid="prompt-fragment-select"] option');
    const optionCount = await options.count();
    test.skip(optionCount < 2, 'No existing prompt fragments available to validate marker insertion.');
    const fragmentKey = await options.nth(1).getAttribute('value');
    expect(fragmentKey).toBeTruthy();

    await m.locator('[data-testid="prompt-fragment-select"]').selectOption(fragmentKey!);
    const editor = m.locator('[data-testid="prompt-template-editor"]');
    await editor.fill('Alpha Beta Gamma');

    await editor.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(6, 6);
    });

    await m.locator('[data-testid="insert-fragment-marker"]').click();

    const updated = await editor.inputValue();
    expect(updated).toContain(`{{>${fragmentKey!}}}`);
    expect(updated.startsWith('Alpha ')).toBeTruthy();
    expect(updated.endsWith('Beta Gamma')).toBeTruthy();
  });
});
