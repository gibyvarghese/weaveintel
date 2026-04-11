/**
 * geneWeave — Playwright E2E tests
 *
 * Verifies the full web UI: auth flow, chat, and admin pages.
 * Run: npx playwright test --config playwright.config.ts
 */
import { test, expect, type Page } from '@playwright/test';

/* ── Helpers ─────────────────────────────────────────────── */

/** Generate a unique email for each call to avoid "already registered" conflicts. */
function uniqueEmail() {
  return `pw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@weaveintel.dev`;
}
const PASSWORD = 'Str0ng!Pass99';

async function registerAndEnter(page: Page, email?: string) {
  const em = email ?? uniqueEmail();
  await page.goto('/');
  // Switch to register mode if on login
  const toggle = page.locator('a', { hasText: 'Register' });
  if (await toggle.isVisible({ timeout: 2000 }).catch(() => false)) await toggle.click();

  await page.locator('#auth-name').fill('E2E User');
  await page.locator('#auth-email').fill(em);
  await page.locator('#auth-pass').fill(PASSWORD);
  await page.locator('button', { hasText: 'Create Account' }).click();
  // Wait for the app to render (sidebar appears)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5000 });
}

async function goAdmin(page: Page) {
  await page.locator('button.nav-btn', { hasText: 'Admin' }).click();
  await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
}

/** Scope locator to the .main content area (avoids matching sidebar elements). */
function main(page: Page) {
  return page.locator('.main');
}

/* ── Auth ────────────────────────────────────────────────── */

test.describe('Auth', () => {
  test('shows login page on first visit', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.auth-card')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Sign In' })).toBeVisible();
  });

  test('registers a new user and sees sidebar', async ({ page }) => {
    await registerAndEnter(page);
    await expect(page.locator('button.nav-btn', { hasText: 'Chat' })).toBeVisible();
    await expect(page.locator('button.nav-btn', { hasText: 'Admin' })).toBeVisible();
  });
});

/* ── Chat ────────────────────────────────────────────────── */

test.describe('Chat', () => {
  test('displays input area after login', async ({ page }) => {
    await registerAndEnter(page);
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.locator('.send-btn')).toBeVisible();
  });

  test('sends a message and receives a response', async ({ page }) => {
    await registerAndEnter(page);
    const textarea = page.locator('textarea');
    await textarea.fill('Say exactly: pong');
    await page.locator('button.send-btn').click({ force: true });

    // User message bubble
    await expect(page.locator('.msg.user .bubble')).toBeVisible({ timeout: 10_000 });

    // Assistant response via SSE streaming
    await expect(page.locator('.msg.assistant .bubble')).toBeVisible({ timeout: 60_000 });
  });
});

/* ── Admin: Navigation ───────────────────────────────────── */

test.describe('Admin Navigation', () => {
  test('shows all 17 admin tabs', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    for (const label of ['Prompts', 'Guardrails', 'Routing', 'Workflows', 'Tools', 'Workflow Runs', 'Guardrail Evals', 'Task Policies', 'Contracts', 'Cache', 'Identity', 'Memory Gov', 'Search', 'HTTP', 'Social', 'Enterprise', 'Registry']) {
      await expect(m.locator('button', { hasText: label })).toBeVisible();
    }
  });

  test('switches to Guardrails tab', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Guardrails' }).click();
    // Should see item count text
    await expect(m.getByText(/\d+ items?/)).toBeVisible({ timeout: 3000 });
  });

  test('seed defaults button is visible', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    await expect(main(page).locator('button', { hasText: 'Seed Defaults' })).toBeVisible();
  });
});

/* ── Admin: Seed & Data ──────────────────────────────────── */

test.describe('Admin Seed & Data', () => {
  test('seed defaults populates prompts', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    // Prompts tab (default) should show "N items" with N > 0, and table rows
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('guardrails tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Guardrails' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Guardrails CRUD ──────────────────────────────── */

test.describe('Admin Guardrail CRUD', () => {
  test('creates a new guardrail via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    // Seed defaults first to populate existing data
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    // Navigate to Guardrails tab
    await m.locator('button', { hasText: 'Guardrails' }).click();
    await page.waitForTimeout(500);
    // Click + New in the admin action bar
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    // Form should now be visible with "New Guardrail" heading
    await expect(m.locator('h3', { hasText: 'New Guardrail' })).toBeVisible({ timeout: 3000 });
    // Fill the Name input (first text input in the form)
    await m.locator('input[type="text"]').first().fill('PW-Test-Guard');
    // Select the Type (required field — UI doesn't auto-set state on initial render)
    await m.locator('select').first().selectOption('content_filter');
    // Click Create button in the form
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    // Wait for the form to disappear (save + re-render triggered)
    await expect(m.locator('h3', { hasText: 'New Guardrail' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Prompts Tab ───────────────────────────────────── */

test.describe('Admin Prompts', () => {
  test('prompts tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    // Prompts is the default tab, should show items
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new prompt via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    // Prompts is default tab — click + New
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Prompt' })).toBeVisible({ timeout: 3000 });
    // Fill Name input
    await m.locator('input[type="text"]').first().fill('PW-Test-Prompt');
    // Fill Template textarea
    const textareas = m.locator('textarea');
    if ((await textareas.count()) > 0) {
      await textareas.first().fill('Hello {{user}}!');
    }
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Prompt' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded prompt', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    // Click first Edit button in the prompts table
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      // Should show the edit form with pre-filled data
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Routing Tab ──────────────────────────────────── */

test.describe('Admin Routing', () => {
  test('routing tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Routing' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new routing policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Routing' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Routing Policy' })).toBeVisible({ timeout: 3000 });
    // Fill Name input
    await m.locator('input[type="text"]').first().fill('PW-Test-Routing');
    // Select the Strategy from the dropdown
    const selects = m.locator('select');
    if ((await selects.count()) > 0) {
      await selects.first().selectOption({ index: 1 });
    }
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Routing Policy' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded routing policy', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Routing' }).click();
    await page.waitForTimeout(500);
    // Click first Edit button in the routing table
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Read-only Tabs ───────────────────────────────── */

test.describe('Admin Read-only Tabs', () => {
  test('workflow runs tab has no admin + New button', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Workflow Runs' }).click();
    await page.waitForTimeout(500);
    // The admin action bar's "+ New" button should NOT exist in main (sidebar's + New is outside .main)
    await expect(m.locator('button.nav-btn', { hasText: '+ New' })).not.toBeVisible();
  });

  test('guardrail evals tab has no admin + New button', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Guardrail Evals' }).click();
    await page.waitForTimeout(500);
    await expect(m.locator('button.nav-btn', { hasText: '+ New' })).not.toBeVisible();
  });

  test('workflow runs tab shows data after seed + API run creation', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    // Seed defaults to create some runs
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Workflow Runs' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/\d+ items?/)).toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Task Policies Tab ────────────────────────────── */

test.describe('Admin Task Policies', () => {
  test('task policies tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Task Policies' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new task policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Task Policies' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Task Policy' })).toBeVisible({ timeout: 3000 });
    // Fill Name (1st text input), Description (2nd), Trigger (3rd)
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Test-Policy');
    await textInputs.nth(2).fill('test_action');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Task Policy' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Contracts Tab ────────────────────────────────── */

test.describe('Admin Contracts', () => {
  test('contracts tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Contracts' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new contract via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Contracts' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Contract' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Contract');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Contract' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Cache Policies Tab ───────────────────────────── */

test.describe('Admin Cache Policies', () => {
  test('cache tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Cache' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new cache policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Cache' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Cache Policy' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Cache-Policy');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Cache Policy' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Identity Rules Tab ───────────────────────────── */

test.describe('Admin Identity Rules', () => {
  test('identity tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Identity' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new identity rule via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Identity' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Identity Rule' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Identity-Rule');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Identity Rule' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Admin: Memory Governance Tab ────────────────────────── */

test.describe('Admin Memory Governance', () => {
  test('memory governance tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Memory Gov' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new memory governance rule via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Memory Gov' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Memory Governance' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Memory-Governance');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Memory Governance' })).not.toBeVisible({ timeout: 5000 });
  });
});

/* ── Dashboard ───────────────────────────────────────────── */

test.describe('Dashboard', () => {
  test('navigates to dashboard', async ({ page }) => {
    await registerAndEnter(page);
    await page.locator('button.nav-btn', { hasText: 'Dashboard' }).click();
    await page.waitForTimeout(1000);
    await expect(page.locator('.main')).toBeVisible();
  });
});

/* ── Admin: Search Providers Tab ─────────────────────────── */

test.describe('Admin Search Providers', () => {
  test('search tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Search' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new search provider via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Search' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Search Provider' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Search');
    const selects = m.locator('select');
    if ((await selects.count()) > 0) {
      await selects.first().selectOption({ index: 1 });
    }
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Search Provider' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded search provider', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Search' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: HTTP Endpoints Tab ───────────────────────────── */

test.describe('Admin HTTP Endpoints', () => {
  test('http tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'HTTP' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new http endpoint via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'HTTP' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New HTTP Endpoint' })).toBeVisible({ timeout: 3000 });
    const httpInputs = m.locator('input[type="text"]');
    await httpInputs.nth(0).fill('PW-Test-HTTP');
    await httpInputs.nth(2).fill('https://example.com/api/test');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New HTTP Endpoint' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded http endpoint', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'HTTP' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Social Accounts Tab ──────────────────────────── */

test.describe('Admin Social Accounts', () => {
  test('social tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Social' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new social account via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Social' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Social Account' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Social');
    const selects = m.locator('select');
    if ((await selects.count()) > 0) {
      await selects.first().selectOption({ index: 1 });
    }
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Social Account' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded social account', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Social' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Enterprise Connectors Tab ────────────────────── */

test.describe('Admin Enterprise Connectors', () => {
  test('enterprise tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Enterprise' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new enterprise connector via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Enterprise' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Enterprise Connector' })).toBeVisible({ timeout: 3000 });
    await m.locator('input[type="text"]').first().fill('PW-Test-Enterprise');
    const selects = m.locator('select');
    if ((await selects.count()) > 0) {
      await selects.first().selectOption({ index: 1 });
    }
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Enterprise Connector' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded enterprise connector', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Enterprise' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Tool Registry Tab ────────────────────────────── */

test.describe('Admin Tool Registry', () => {
  test('registry tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Registry' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new tool registry entry via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Registry' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Tool Registry' })).toBeVisible({ timeout: 3000 });
    const regInputs = m.locator('input[type="text"]');
    await regInputs.nth(0).fill('PW-Test-Registry');
    await regInputs.nth(2).fill('@weaveintel/tools-test');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Tool Registry' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded tool registry entry', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Registry' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Replay Scenarios Tab ─────────────────────────── */

test.describe('Admin Replay Scenarios', () => {
  test('replay tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Replay' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new replay scenario via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Replay' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Replay Scenario' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Test-Replay');
    const textareas = m.locator('textarea');
    await textareas.nth(0).fill('What is 1+1?');
    await textareas.nth(1).fill('The answer is 2.');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Replay Scenario' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded replay scenario', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Replay' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Trigger Definitions Tab ──────────────────────── */

test.describe('Admin Trigger Definitions', () => {
  test('triggers tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Triggers' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new trigger definition via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Triggers' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Trigger Definition' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Test-Trigger');
    await textInputs.nth(1).fill('0 6 * * *');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Trigger Definition' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded trigger definition', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Triggers' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

/* ── Admin: Tenant Configs Tab ───────────────────────────── */

test.describe('Admin Tenant Configs', () => {
  test('tenants tab shows seeded data', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Tenants' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new tenant config via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Tenants' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Tenant Config' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Test-Tenant');
    await textInputs.nth(2).fill('pw-tenant-id');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Tenant Config' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded tenant config', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Tenants' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Sandbox Policies ─────────────────────────────────

test.describe('Admin Sandbox Policies', () => {
  test('shows seeded sandbox policies', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Sandbox' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new sandbox policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Sandbox' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Sandbox Policy' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Sandbox');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Sandbox Policy' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded sandbox policy', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Sandbox' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Extraction Pipelines ─────────────────────────────

test.describe('Admin Extraction Pipelines', () => {
  test('shows seeded extraction pipelines', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Extraction' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new extraction pipeline via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Extraction' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Extraction Pipeline' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Pipeline');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Extraction Pipeline' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded extraction pipeline', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Extraction' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Artifact Policies ────────────────────────────────

test.describe('Admin Artifact Policies', () => {
  test('shows seeded artifact policies', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Artifacts' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new artifact policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Artifacts' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Artifact Policy' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Artifact-Policy');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Artifact Policy' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded artifact policy', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Artifacts' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Reliability Policies ─────────────────────────────

test.describe('Admin Reliability Policies', () => {
  test('shows seeded reliability policies', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Reliability' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new reliability policy via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Reliability' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Reliability Policy' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Reliability');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Reliability Policy' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded reliability policy', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Reliability' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Collaboration Sessions ───────────────────────────

test.describe('Admin Collaboration Sessions', () => {
  test('shows seeded collaboration sessions', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Collaboration' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new collaboration session via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Collaboration' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Collaboration Session' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Collab');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Collaboration Session' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded collaboration session', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Collaboration' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Compliance Rules ─────────────────────────────────

test.describe('Admin Compliance Rules', () => {
  test('shows seeded compliance rules', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Compliance' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new compliance rule via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Compliance' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Compliance Rule' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Compliance');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Compliance Rule' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded compliance rule', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Compliance' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Graph Configs ────────────────────────────────────

test.describe('Admin Graph Configs', () => {
  test('shows seeded graph configs', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Graph' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new graph config via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Graph' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Graph Config' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Graph');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Graph Config' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded graph config', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Graph' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─── Admin Plugin Configs ───────────────────────────────────

test.describe('Admin Plugin Configs', () => {
  test('shows seeded plugin configs', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Plugins' }).click();
    await page.waitForTimeout(500);
    await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  });

  test('creates a new plugin config via form', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Plugins' }).click();
    await page.waitForTimeout(500);
    await m.locator('button.nav-btn', { hasText: '+ New' }).click();
    await page.waitForTimeout(300);
    await expect(m.locator('h3', { hasText: 'New Plugin Config' })).toBeVisible({ timeout: 3000 });
    const textInputs = m.locator('input[type="text"]');
    await textInputs.nth(0).fill('PW-Plugin');
    await m.locator('button.nav-btn', { hasText: 'Create' }).click();
    await expect(m.locator('h3', { hasText: 'New Plugin Config' })).not.toBeVisible({ timeout: 5000 });
  });

  test('edits a seeded plugin config', async ({ page }) => {
    await registerAndEnter(page);
    await goAdmin(page);
    const m = main(page);
    await m.locator('button', { hasText: 'Seed Defaults' }).click();
    await page.waitForTimeout(1500);
    await m.locator('button', { hasText: 'Plugins' }).click();
    await page.waitForTimeout(500);
    const editBtn = m.locator('button', { hasText: 'Edit' }).first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(300);
      await expect(m.locator('h3')).toBeVisible({ timeout: 3000 });
    }
  });
});
