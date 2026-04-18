# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e.e2e.ts >> Admin Validation Rules >> creates a new validation rule via form
- Location: src/e2e.e2e.ts:1441:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 403
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary [ref=e4]:
    - generic [ref=e5]:
      - text: ✦
      - generic [ref=e6]: geneWeave
    - generic [ref=e7]:
      - button "⌂ Home" [ref=e8] [cursor=pointer]:
        - text: ⌂
        - generic [ref=e9]: Home
      - button "⚡ Connectors" [ref=e10] [cursor=pointer]:
        - text: ⚡
        - generic [ref=e11]: Connectors
      - button "⚙ Admin" [ref=e12] [cursor=pointer]:
        - text: ⚙
        - generic [ref=e13]: Admin
      - button "▦ Dashboard" [ref=e14] [cursor=pointer]:
        - text: ▦
        - generic [ref=e15]: Dashboard
    - generic [ref=e16]:
      - generic [ref=e17]: Recent Chats
      - generic [ref=e18] [cursor=pointer]:
        - generic [ref=e19]:
          - generic [ref=e20]: Analyze this mini dataset and give me ke…
          - generic [ref=e21]: 4/18/2026, 10:21:40 PM
        - button "×" [ref=e22]
    - button "⎋ Log Out" [ref=e25] [cursor=pointer]:
      - text: ⎋
      - generic [ref=e26]: Log Out
  - generic [ref=e28]:
    - heading "Administration" [level=2] [ref=e29]
    - generic [ref=e30]:
      - generic [ref=e31]:
        - generic [ref=e32]: 🤖 Core AI
        - button "Prompts" [ref=e33] [cursor=pointer]
        - button "Skills" [ref=e34] [cursor=pointer]
        - button "Worker Agents" [ref=e35] [cursor=pointer]
        - button "Guardrails" [ref=e36] [cursor=pointer]
        - button "Routing" [ref=e37] [cursor=pointer]
        - button "Model Pricing" [ref=e38] [cursor=pointer]
        - button "Workflows" [ref=e39] [cursor=pointer]
        - button "Tools" [ref=e40] [cursor=pointer]
        - generic [ref=e41]: ⚖️ Governance
        - button "Task Policies" [ref=e42] [cursor=pointer]
        - button "Contracts" [ref=e43] [cursor=pointer]
        - button "Identity Rules" [ref=e44] [cursor=pointer]
        - button "Memory Gov" [ref=e45] [cursor=pointer]
        - button "Memory Rules" [ref=e46] [cursor=pointer]
        - button "Compliance" [ref=e47] [cursor=pointer]
        - generic [ref=e48]: 🔌 Integrations
        - button "Search" [ref=e49] [cursor=pointer]
        - button "HTTP" [ref=e50] [cursor=pointer]
        - button "Social" [ref=e51] [cursor=pointer]
        - button "Enterprise" [ref=e52] [cursor=pointer]
        - button "Registry" [ref=e53] [cursor=pointer]
        - generic [ref=e54]: ⚡ Automation
        - button "Triggers" [ref=e55] [cursor=pointer]
        - button "Replay" [ref=e56] [cursor=pointer]
        - button "Cache" [ref=e57] [cursor=pointer]
        - button "Reliability" [ref=e58] [cursor=pointer]
        - generic [ref=e59]: 🏗️ Infrastructure
        - button "Sandbox" [ref=e60] [cursor=pointer]
        - button "Extraction" [ref=e61] [cursor=pointer]
        - button "Artifacts" [ref=e62] [cursor=pointer]
        - button "Tenants" [ref=e63] [cursor=pointer]
        - generic [ref=e64]: 🧩 Advanced
        - button "Collaboration" [ref=e65] [cursor=pointer]
        - button "Graph" [ref=e66] [cursor=pointer]
        - button "Plugins" [ref=e67] [cursor=pointer]
        - generic [ref=e68]: 🛠️ Developer
        - button "Scaffolds" [ref=e69] [cursor=pointer]
        - button "Recipes" [ref=e70] [cursor=pointer]
        - button "Widgets" [ref=e71] [cursor=pointer]
        - button "Validation" [ref=e72] [cursor=pointer]
        - generic [ref=e73]: 📊 Monitoring
        - button "Workflow Runs" [ref=e74] [cursor=pointer]
        - button "Guardrail Evals" [ref=e75] [cursor=pointer]
        - button "Memory Extraction" [ref=e76] [cursor=pointer]
        - generic [ref=e77]: ℹ️ System
      - generic [ref=e78]:
        - heading "Prompts" [level=3] [ref=e79]
        - generic [ref=e80]:
          - generic [ref=e81]: 0 items
          - button "+ New" [ref=e82] [cursor=pointer]
        - generic [ref=e83]: No records found.
```

# Test source

```ts
  1   | /**
  2   |  * geneWeave — Playwright E2E tests
  3   |  *
  4   |  * Verifies the full web UI: auth flow, chat, and admin pages.
  5   |  * Run: npx playwright test --config playwright.config.ts
  6   |  */
  7   | import { test, expect, type Page } from '@playwright/test';
  8   | 
  9   | /* ── Helpers ─────────────────────────────────────────────── */
  10  | 
  11  | const PASSWORD = 'Str0ng!Pass99';
  12  | const ADMIN_EMAIL = 'pw-e2e-admin@weaveintel.dev';
  13  | 
  14  | async function registerAndEnter(page: Page, email?: string) {
  15  |   const em = email ?? ADMIN_EMAIL;
  16  |   await page.goto('/');
  17  | 
  18  |   // Reuse an existing authenticated session when available.
  19  |   if (await page.locator('.workspace-nav').isVisible({ timeout: 1000 }).catch(() => false)) return;
  20  | 
  21  |   // Use API auth to avoid flaky mode-toggle interactions in the auth form.
  22  |   let login = await page.request.post('/api/auth/login', {
  23  |     data: { email: em, password: PASSWORD },
  24  |   });
  25  |   if (login.status() !== 200) {
  26  |     const register = await page.request.post('/api/auth/register', {
  27  |       data: { name: 'E2E User', email: em, password: PASSWORD },
  28  |     });
  29  |     expect([201, 409]).toContain(register.status());
  30  | 
  31  |     login = await page.request.post('/api/auth/login', {
  32  |       data: { email: em, password: PASSWORD },
  33  |     });
  34  |     expect(login.status()).toBe(200);
  35  |   }
  36  | 
  37  |   await page.goto('/');
  38  |   // Wait for the app shell to render after auth completes.
  39  |   await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 5000 });
  40  | }
  41  | 
  42  | async function goAdmin(page: Page) {
  43  |   await page.locator('.profile-avatar').click();
  44  |   await page.locator('.pf-btn', { hasText: 'Admin' }).click();
  45  |   await expect(page.locator('h2', { hasText: 'Administration' })).toBeVisible({ timeout: 5000 });
  46  | }
  47  | 
  48  | async function seedDefaults(page: Page) {
  49  |   const csrfToken = await page.evaluate(async () => {
  50  |     const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  51  |     const data = await res.json().catch(() => ({}));
  52  |     return data?.csrfToken ?? '';
  53  |   });
  54  |   expect(csrfToken).toBeTruthy();
  55  | 
  56  |   const seedStatus = await page.evaluate(async (csrf) => {
  57  |     const res = await fetch('/api/admin/seed', {
  58  |       method: 'POST',
  59  |       credentials: 'same-origin',
  60  |       headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
  61  |       body: '{}',
  62  |     });
  63  |     return res.status;
  64  |   }, csrfToken);
> 65  |   expect(seedStatus).toBe(200);
      |                      ^ Error: expect(received).toBe(expected) // Object.is equality
  66  | }
  67  | 
  68  | /** Scope locator to the .main content area (avoids matching sidebar elements). */
  69  | function main(page: Page) {
  70  |   return page.locator('.main');
  71  | }
  72  | 
  73  | /* ── Auth ────────────────────────────────────────────────── */
  74  | 
  75  | test.describe('Auth', () => {
  76  |   test('shows login page on first visit', async ({ page }) => {
  77  |     await page.goto('/');
  78  |     await expect(page.locator('.auth-card')).toBeVisible();
  79  |     await expect(page.locator('button', { hasText: 'Sign In' })).toBeVisible();
  80  |   });
  81  | 
  82  |   test('registers a new user and sees sidebar', async ({ page }) => {
  83  |     await registerAndEnter(page);
  84  |     // After login, navigation shell and profile avatar should be visible.
  85  |     await expect(page.locator('.workspace-nav')).toBeVisible();
  86  |     await expect(page.locator('.profile-avatar')).toBeVisible();
  87  |   });
  88  | });
  89  | 
  90  | /* ── Chat ────────────────────────────────────────────────── */
  91  | 
  92  | test.describe('Chat', () => {
  93  |   test('displays input area after login', async ({ page }) => {
  94  |     await registerAndEnter(page);
  95  |     await expect(page.locator('textarea')).toBeVisible();
  96  |     await expect(page.locator('.send-btn')).toBeVisible();
  97  |   });
  98  | 
  99  |   test('sends a message and receives a response', async ({ page }) => {
  100 |     await registerAndEnter(page);
  101 |     const textarea = page.locator('textarea');
  102 |     await textarea.fill('Say exactly: pong');
  103 |     await page.locator('button.send-btn').click({ force: true });
  104 | 
  105 |     // User message bubble
  106 |     await expect(page.locator('.msg.user .bubble').last()).toBeVisible({ timeout: 10_000 });
  107 | 
  108 |     // Assistant response via SSE streaming
  109 |     await expect(page.locator('.msg.assistant .bubble').last()).toBeVisible({ timeout: 60_000 });
  110 |   });
  111 | });
  112 | 
  113 | /* ── Admin: Navigation ───────────────────────────────────── */
  114 | 
  115 | test.describe('Admin Navigation', () => {
  116 |   test('shows all 17 admin tabs', async ({ page }) => {
  117 |     await registerAndEnter(page);
  118 |     await goAdmin(page);
  119 |     const m = main(page);
  120 |     for (const label of ['Prompts', 'Guardrails', 'Routing', 'Workflows', 'Tools', 'Workflow Runs', 'Guardrail Evals', 'Task Policies', 'Contracts', 'Cache', 'Identity', 'Memory Gov', 'Search', 'HTTP', 'Social', 'Enterprise', 'Registry']) {
  121 |       await expect(m.locator('button', { hasText: label })).toBeVisible();
  122 |     }
  123 |   });
  124 | 
  125 |   test('switches to Guardrails tab', async ({ page }) => {
  126 |     await registerAndEnter(page);
  127 |     await goAdmin(page);
  128 |     const m = main(page);
  129 |     await m.locator('button', { hasText: 'Guardrails' }).click();
  130 |     // Should see item count text
  131 |     await expect(m.getByText(/\d+ items?/)).toBeVisible({ timeout: 3000 });
  132 |   });
  133 | 
  134 |   test('seed defaults API succeeds for admin user', async ({ page }) => {
  135 |     await registerAndEnter(page);
  136 |     await goAdmin(page);
  137 |     await seedDefaults(page);
  138 |   });
  139 | });
  140 | 
  141 | /* ── Admin: Seed & Data ──────────────────────────────────── */
  142 | 
  143 | test.describe('Admin Seed & Data', () => {
  144 |   test('seed defaults populates prompts', async ({ page }) => {
  145 |     await registerAndEnter(page);
  146 |     await goAdmin(page);
  147 |     const m = main(page);
  148 |     await seedDefaults(page);
  149 |     await page.waitForTimeout(1500);
  150 |     // Prompts tab (default) should show "N items" with N > 0, and table rows
  151 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  152 |   });
  153 | 
  154 |   test('guardrails tab shows seeded data', async ({ page }) => {
  155 |     await registerAndEnter(page);
  156 |     await goAdmin(page);
  157 |     const m = main(page);
  158 |     await seedDefaults(page);
  159 |     await page.waitForTimeout(1500);
  160 |     await m.locator('button', { hasText: 'Guardrails' }).click();
  161 |     await page.waitForTimeout(500);
  162 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  163 |   });
  164 | });
  165 | 
```