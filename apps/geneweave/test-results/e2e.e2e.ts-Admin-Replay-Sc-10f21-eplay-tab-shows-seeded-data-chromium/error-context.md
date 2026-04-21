# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e.e2e.ts >> Admin Replay Scenarios >> replay tab shows seeded data
- Location: src/e2e.e2e.ts:904:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.main').getByText(/[1-9]\d* items?/)
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('.main').getByText(/[1-9]\d* items?/)

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]: ✦
      - generic [ref=e7]: geneWeave
      - button "«" [ref=e8] [cursor=pointer]
    - generic [ref=e9]:
      - button "↑" [ref=e10] [cursor=pointer]
      - button "↓" [ref=e11] [cursor=pointer]
    - generic [ref=e12]:
      - generic [ref=e13]:
        - button "Home" [ref=e14] [cursor=pointer]:
          - img [ref=e16]
          - generic [ref=e20]: Home
        - button "Dashboard" [ref=e21] [cursor=pointer]:
          - img [ref=e23]
          - generic [ref=e28]: Dashboard
        - button "Connectors" [ref=e29] [cursor=pointer]:
          - img [ref=e31]
          - generic [ref=e36]: Connectors
        - generic [ref=e37]:
          - button "Admin ▾" [ref=e38] [cursor=pointer]:
            - img [ref=e40]
            - generic [ref=e43]: Admin
            - generic [ref=e44]: ▾
          - generic [ref=e45]:
            - button "Prompt Studio ▾" [ref=e46] [cursor=pointer]:
              - generic [ref=e47]: Prompt Studio
              - generic [ref=e48]: ▾
            - generic [ref=e49]:
              - button "Prompts" [ref=e50] [cursor=pointer]
              - button "Prompt Versions" [ref=e51] [cursor=pointer]
              - button "Prompt Experiments" [ref=e52] [cursor=pointer]
              - button "Frameworks" [ref=e53] [cursor=pointer]
              - button "Fragments" [ref=e54] [cursor=pointer]
              - button "Output Contracts" [ref=e55] [cursor=pointer]
              - button "Strategies" [ref=e56] [cursor=pointer]
              - button "Prompt Optimizers" [ref=e57] [cursor=pointer]
              - button "Optimization Runs" [ref=e58] [cursor=pointer]
              - button "Eval Datasets" [ref=e59] [cursor=pointer]
              - button "Eval Runs" [ref=e60] [cursor=pointer]
              - button "Pricing" [ref=e61] [cursor=pointer]
            - button "Orchestration ▾" [ref=e62] [cursor=pointer]:
              - generic [ref=e63]: Orchestration
              - generic [ref=e64]: ▾
            - generic [ref=e65]:
              - button "Skills" [ref=e66] [cursor=pointer]
              - button "Agents" [ref=e67] [cursor=pointer]
              - button "Tool Catalog" [ref=e68] [cursor=pointer]
              - button "Tool Policies" [ref=e69] [cursor=pointer]
              - button "Tool Audit" [ref=e70] [cursor=pointer]
              - button "Tool Health" [ref=e71] [cursor=pointer]
              - button "Tool Credentials" [ref=e72] [cursor=pointer]
              - button "Tool Simulation" [ref=e73] [cursor=pointer]
              - button "Tool Approvals" [ref=e74] [cursor=pointer]
              - button "Workflows" [ref=e75] [cursor=pointer]
              - button "Routing" [ref=e76] [cursor=pointer]
              - button "Task Policies" [ref=e77] [cursor=pointer]
              - button "Triggers" [ref=e78] [cursor=pointer]
              - button "Replay" [ref=e79] [cursor=pointer]
            - button "Governance ▾" [ref=e80] [cursor=pointer]:
              - generic [ref=e81]: Governance
              - generic [ref=e82]: ▾
            - button "Integrations ▾" [ref=e83] [cursor=pointer]:
              - generic [ref=e84]: Integrations
              - generic [ref=e85]: ▾
            - button "Knowledge ▾" [ref=e86] [cursor=pointer]:
              - generic [ref=e87]: Knowledge
              - generic [ref=e88]: ▾
            - button "Infrastructure ▾" [ref=e89] [cursor=pointer]:
              - generic [ref=e90]: Infrastructure
              - generic [ref=e91]: ▾
            - button "Monitoring ▾" [ref=e92] [cursor=pointer]:
              - generic [ref=e93]: Monitoring
              - generic [ref=e94]: ▾
            - button "Developer ▾" [ref=e95] [cursor=pointer]:
              - generic [ref=e96]: Developer
              - generic [ref=e97]: ▾
      - generic:
        - button "Recent Chats ▾" [ref=e98] [cursor=pointer]:
          - generic [ref=e99]: Recent Chats
          - generic [ref=e100]: ▾
        - generic [ref=e101] [cursor=pointer]:
          - generic [ref=e102]:
            - generic [ref=e103]: New Chat
            - generic [ref=e104]: 4/21/2026, 12:55:24 AM
          - button "×" [ref=e105]
        - generic [ref=e106] [cursor=pointer]:
          - generic [ref=e107]:
            - generic [ref=e108]: New Chat
            - generic [ref=e109]: 4/21/2026, 12:55:20 AM
          - button "×" [ref=e110]
        - generic [ref=e111] [cursor=pointer]:
          - generic [ref=e112]:
            - generic [ref=e113]: New Chat
            - generic [ref=e114]: 4/21/2026, 12:55:15 AM
          - button "×" [ref=e115]
        - generic [ref=e116] [cursor=pointer]:
          - generic [ref=e117]:
            - generic [ref=e118]: New Chat
            - generic [ref=e119]: 4/21/2026, 12:55:15 AM
          - button "×" [ref=e120]
  - generic [ref=e121]:
    - generic [ref=e123]:
      - generic [ref=e124]:
        - img "E2E User" [ref=e125]
        - generic [ref=e126]:
          - generic [ref=e127]: E2E User
          - generic [ref=e128]: pw-e2e-admin@weaveintel.dev
      - generic [ref=e129]: ◷ Tue, Apr 21
      - textbox "Search chats..." [ref=e131]
      - generic [ref=e132]:
        - button "+ New Chat" [ref=e133] [cursor=pointer]
        - button "E2E User" [ref=e135] [cursor=pointer]:
          - img "E2E User" [ref=e136]
    - generic [ref=e137]:
      - heading "Administration" [level=2] [ref=e138]
      - generic [ref=e139]: Replay Scenarios
      - generic [ref=e142]:
        - generic [ref=e143]:
          - heading "Replay Scenarios" [level=3] [ref=e144]
          - button "+ New" [ref=e145] [cursor=pointer]
        - generic [ref=e146]:
          - generic [ref=e147]:
            - generic: 🔍
            - textbox "Search 3 records… (name is writer, score > 10, status is not draft)" [ref=e148]
          - button "⊞ Columns" [ref=e149] [cursor=pointer]
        - table [ref=e150]:
          - rowgroup [ref=e151]:
            - row "name ↕ model ↕ provider ↕ enabled ↕ description ↕ golden prompt ↕" [ref=e152]:
              - columnheader "name ↕" [ref=e153] [cursor=pointer]:
                - text: name
                - generic [ref=e154]: ↕
              - columnheader "model ↕" [ref=e155] [cursor=pointer]:
                - text: model
                - generic [ref=e156]: ↕
              - columnheader "provider ↕" [ref=e157] [cursor=pointer]:
                - text: provider
                - generic [ref=e158]: ↕
              - columnheader "enabled ↕" [ref=e159] [cursor=pointer]:
                - text: enabled
                - generic [ref=e160]: ↕
              - columnheader "description ↕" [ref=e161] [cursor=pointer]:
                - text: description
                - generic [ref=e162]: ↕
              - columnheader "golden prompt ↕" [ref=e163] [cursor=pointer]:
                - text: golden prompt
                - generic [ref=e164]: ↕
          - rowgroup [ref=e165]:
            - row "Code Review Scenario gpt-4o openai 1 Test code review accuracy against a golden response Review this JavaScript function for bugs:\\nfunction add(a…" [ref=e166] [cursor=pointer]:
              - cell "Code Review Scenario" [ref=e167]
              - cell "gpt-4o" [ref=e168]
              - cell "openai" [ref=e169]
              - cell "1" [ref=e170]
              - cell "Test code review accuracy against a golden response" [ref=e171]
              - cell "Review this JavaScript function for bugs:\\nfunction add(a…" [ref=e172]
            - row "Greeting Test gpt-4o-mini openai 1 Verify the assistant handles basic greetings correctly Hello! How are you?" [ref=e173] [cursor=pointer]:
              - cell "Greeting Test" [ref=e174]
              - cell "gpt-4o-mini" [ref=e175]
              - cell "openai" [ref=e176]
              - cell "1" [ref=e177]
              - cell "Verify the assistant handles basic greetings correctly" [ref=e178]
              - cell "Hello! How are you?" [ref=e179]
            - 'row "Summarization Quality — — 1 Test document summarization quality and completeness Summarize: AI is transforming healthcare through diagnost…" [ref=e180] [cursor=pointer]':
              - cell "Summarization Quality" [ref=e181]
              - cell "—" [ref=e182]
              - cell "—" [ref=e183]
              - cell "1" [ref=e184]
              - cell "Test document summarization quality and completeness" [ref=e185]
              - 'cell "Summarize: AI is transforming healthcare through diagnost…" [ref=e186]'
        - generic [ref=e187]:
          - generic [ref=e188]: 1–3 of 3 records
          - generic [ref=e189]:
            - button "← Prev" [disabled]
            - button "1" [disabled]
            - button "Next →" [disabled]
```

# Test source

```ts
  811  |     await seedDefaults(page);
  812  |     await page.waitForTimeout(1500);
  813  |     await openAdminTab(page, 'Tool Policies');
  814  |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  815  |   });
  816  | 
  817  |   test('creates a new tool policy via form', async ({ page }) => {
  818  |     await registerAndEnter(page);
  819  |     await goAdmin(page);
  820  |     const m = main(page);
  821  |     await seedDefaults(page);
  822  |     await page.waitForTimeout(1500);
  823  |     await openAdminTab(page, 'Tool Policies');
  824  |     await clickAdminNewButton(m);
  825  |     await page.waitForTimeout(300);
  826  |     await expect(m.locator('h3', { hasText: 'New Tool Policy' })).toBeVisible({ timeout: 3000 });
  827  |     const inputs = m.locator('input[type="text"]');
  828  |     await inputs.nth(0).fill('pw-test-policy');
  829  |     await inputs.nth(1).fill('PW Test Policy');
  830  |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  831  |     await expect(m.locator('h3', { hasText: 'New Tool Policy' })).not.toBeVisible({ timeout: 5000 });
  832  |   });
  833  | 
  834  |   test('edits a seeded tool policy', async ({ page }) => {
  835  |     await registerAndEnter(page);
  836  |     await goAdmin(page);
  837  |     const m = main(page);
  838  |     await seedDefaults(page);
  839  |     await page.waitForTimeout(1500);
  840  |     await openAdminTab(page, 'Tool Policies');
  841  |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  842  |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  843  |       await editBtn.click();
  844  |       await page.waitForTimeout(300);
  845  |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  846  |     }
  847  |   });
  848  | });
  849  | 
  850  | /* ── Admin: Tool Audit Tab ───────────────────────────────── */
  851  | 
  852  | test.describe('Admin Tool Audit', () => {
  853  |   test('tool audit tab is visible and shows empty state or list', async ({ page }) => {
  854  |     await registerAndEnter(page);
  855  |     await goAdmin(page);
  856  |     const m = main(page);
  857  |     await seedDefaults(page);
  858  |     await page.waitForTimeout(1500);
  859  |     await openAdminTab(page, 'Tool Audit');
  860  |     // Tab loaded — either empty state or item list is acceptable (no events yet in fresh DB)
  861  |     await expect(m).toBeVisible();
  862  |   });
  863  | 
  864  |   test('tool audit tab has no New button (read-only)', async ({ page }) => {
  865  |     await registerAndEnter(page);
  866  |     await goAdmin(page);
  867  |     const m = main(page);
  868  |     await seedDefaults(page);
  869  |     await page.waitForTimeout(1500);
  870  |     await openAdminTab(page, 'Tool Audit');
  871  |     await page.waitForTimeout(500);
  872  |     await expect(m.locator('button', { hasText: 'New Tool Audit Event' })).not.toBeVisible();
  873  |   });
  874  | });
  875  | 
  876  | /* ── Admin: Tool Health Tab ──────────────────────────────── */
  877  | 
  878  | test.describe('Admin Tool Health', () => {
  879  |   test('tool health tab is visible and shows empty state or list', async ({ page }) => {
  880  |     await registerAndEnter(page);
  881  |     await goAdmin(page);
  882  |     const m = main(page);
  883  |     await seedDefaults(page);
  884  |     await page.waitForTimeout(1500);
  885  |     await openAdminTab(page, 'Tool Health');
  886  |     await expect(m).toBeVisible();
  887  |   });
  888  | 
  889  |   test('tool health tab has no New button (read-only)', async ({ page }) => {
  890  |     await registerAndEnter(page);
  891  |     await goAdmin(page);
  892  |     const m = main(page);
  893  |     await seedDefaults(page);
  894  |     await page.waitForTimeout(1500);
  895  |     await openAdminTab(page, 'Tool Health');
  896  |     await page.waitForTimeout(500);
  897  |     await expect(m.locator('button', { hasText: 'New Tool Health' })).not.toBeVisible();
  898  |   });
  899  | });
  900  | 
  901  | /* ── Admin: Replay Scenarios Tab ─────────────────────────── */
  902  | 
  903  | test.describe('Admin Replay Scenarios', () => {
  904  |   test('replay tab shows seeded data', async ({ page }) => {
  905  |     await registerAndEnter(page);
  906  |     await goAdmin(page);
  907  |     const m = main(page);
  908  |     await seedDefaults(page);
  909  |     await page.waitForTimeout(1500);
  910  |     await openAdminTab(page, 'Replay');
> 911  |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
       |                                                  ^ Error: expect(locator).toBeVisible() failed
  912  |   });
  913  | 
  914  |   test('creates a new replay scenario via form', async ({ page }) => {
  915  |     await registerAndEnter(page);
  916  |     await goAdmin(page);
  917  |     const m = main(page);
  918  |     await seedDefaults(page);
  919  |     await page.waitForTimeout(1500);
  920  |     await openAdminTab(page, 'Replay');
  921  |     await clickAdminNewButton(m);
  922  |     await page.waitForTimeout(300);
  923  |     await expect(m.locator('h3', { hasText: 'New Replay Scenario' })).toBeVisible({ timeout: 3000 });
  924  |     const textInputs = m.locator('input[type="text"]');
  925  |     await textInputs.nth(0).fill('PW-Test-Replay');
  926  |     const textareas = m.locator('textarea');
  927  |     await textareas.nth(0).fill('What is 1+1?');
  928  |     await textareas.nth(1).fill('The answer is 2.');
  929  |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  930  |     await expect(m.locator('h3', { hasText: 'New Replay Scenario' })).not.toBeVisible({ timeout: 5000 });
  931  |   });
  932  | 
  933  |   test('edits a seeded replay scenario', async ({ page }) => {
  934  |     await registerAndEnter(page);
  935  |     await goAdmin(page);
  936  |     const m = main(page);
  937  |     await seedDefaults(page);
  938  |     await page.waitForTimeout(1500);
  939  |     await openAdminTab(page, 'Replay');
  940  |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  941  |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  942  |       await editBtn.click();
  943  |       await page.waitForTimeout(300);
  944  |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  945  |     }
  946  |   });
  947  | });
  948  | 
  949  | /* ── Admin: Trigger Definitions Tab ──────────────────────── */
  950  | 
  951  | test.describe('Admin Trigger Definitions', () => {
  952  |   test('triggers tab shows seeded data', async ({ page }) => {
  953  |     await registerAndEnter(page);
  954  |     await goAdmin(page);
  955  |     const m = main(page);
  956  |     await seedDefaults(page);
  957  |     await page.waitForTimeout(1500);
  958  |     await openAdminTab(page, 'Triggers');
  959  |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  960  |   });
  961  | 
  962  |   test('creates a new trigger definition via form', async ({ page }) => {
  963  |     await registerAndEnter(page);
  964  |     await goAdmin(page);
  965  |     const m = main(page);
  966  |     await seedDefaults(page);
  967  |     await page.waitForTimeout(1500);
  968  |     await openAdminTab(page, 'Triggers');
  969  |     await clickAdminNewButton(m);
  970  |     await page.waitForTimeout(300);
  971  |     await expect(m.locator('h3', { hasText: 'New Trigger Definition' })).toBeVisible({ timeout: 3000 });
  972  |     const textInputs = m.locator('input[type="text"]');
  973  |     await textInputs.nth(0).fill('PW-Test-Trigger');
  974  |     await textInputs.nth(1).fill('0 6 * * *');
  975  |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  976  |     await expect(m.locator('h3', { hasText: 'New Trigger Definition' })).not.toBeVisible({ timeout: 5000 });
  977  |   });
  978  | 
  979  |   test('edits a seeded trigger definition', async ({ page }) => {
  980  |     await registerAndEnter(page);
  981  |     await goAdmin(page);
  982  |     const m = main(page);
  983  |     await seedDefaults(page);
  984  |     await page.waitForTimeout(1500);
  985  |     await openAdminTab(page, 'Triggers');
  986  |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  987  |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  988  |       await editBtn.click();
  989  |       await page.waitForTimeout(300);
  990  |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  991  |     }
  992  |   });
  993  | });
  994  | 
  995  | /* ── Admin: Tenant Configs Tab ───────────────────────────── */
  996  | 
  997  | test.describe('Admin Tenant Configs', () => {
  998  |   test('tenants tab shows seeded data', async ({ page }) => {
  999  |     await registerAndEnter(page);
  1000 |     await goAdmin(page);
  1001 |     const m = main(page);
  1002 |     await seedDefaults(page);
  1003 |     await page.waitForTimeout(1500);
  1004 |     await openAdminTab(page, 'Tenants');
  1005 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  1006 |   });
  1007 | 
  1008 |   test('creates a new tenant config via form', async ({ page }) => {
  1009 |     await registerAndEnter(page);
  1010 |     await goAdmin(page);
  1011 |     const m = main(page);
```