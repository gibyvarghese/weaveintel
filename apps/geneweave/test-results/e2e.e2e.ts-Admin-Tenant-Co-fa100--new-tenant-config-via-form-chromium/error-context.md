# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e.e2e.ts >> Admin Tenant Configs >> creates a new tenant config via form
- Location: src/e2e.e2e.ts:1008:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.main').locator('h3').filter({ hasText: 'New Tenant Config' })
Expected: visible
Timeout: 3000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 3000ms
  - waiting for locator('.main').locator('h3').filter({ hasText: 'New Tenant Config' })

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
            - button "Governance ▾" [ref=e65] [cursor=pointer]:
              - generic [ref=e66]: Governance
              - generic [ref=e67]: ▾
            - button "Integrations ▾" [ref=e68] [cursor=pointer]:
              - generic [ref=e69]: Integrations
              - generic [ref=e70]: ▾
            - button "Knowledge ▾" [ref=e71] [cursor=pointer]:
              - generic [ref=e72]: Knowledge
              - generic [ref=e73]: ▾
            - button "Infrastructure ▾" [ref=e74] [cursor=pointer]:
              - generic [ref=e75]: Infrastructure
              - generic [ref=e76]: ▾
            - generic [ref=e77]:
              - button "Tenants" [ref=e78] [cursor=pointer]
              - button "Cache" [ref=e79] [cursor=pointer]
              - button "Reliability" [ref=e80] [cursor=pointer]
              - button "Sandbox" [ref=e81] [cursor=pointer]
            - button "Monitoring ▾" [ref=e82] [cursor=pointer]:
              - generic [ref=e83]: Monitoring
              - generic [ref=e84]: ▾
            - button "Developer ▾" [ref=e85] [cursor=pointer]:
              - generic [ref=e86]: Developer
              - generic [ref=e87]: ▾
      - generic:
        - button "Recent Chats ▾" [ref=e88] [cursor=pointer]:
          - generic [ref=e89]: Recent Chats
          - generic [ref=e90]: ▾
        - generic [ref=e91] [cursor=pointer]:
          - generic [ref=e92]:
            - generic [ref=e93]: New Chat
            - generic [ref=e94]: 4/21/2026, 12:55:24 AM
          - button "×" [ref=e95]
        - generic [ref=e96] [cursor=pointer]:
          - generic [ref=e97]:
            - generic [ref=e98]: New Chat
            - generic [ref=e99]: 4/21/2026, 12:55:20 AM
          - button "×" [ref=e100]
        - generic [ref=e101] [cursor=pointer]:
          - generic [ref=e102]:
            - generic [ref=e103]: New Chat
            - generic [ref=e104]: 4/21/2026, 12:55:15 AM
          - button "×" [ref=e105]
        - generic [ref=e106] [cursor=pointer]:
          - generic [ref=e107]:
            - generic [ref=e108]: New Chat
            - generic [ref=e109]: 4/21/2026, 12:55:15 AM
          - button "×" [ref=e110]
  - generic [ref=e111]:
    - generic [ref=e113]:
      - generic [ref=e114]:
        - img "E2E User" [ref=e115]
        - generic [ref=e116]:
          - generic [ref=e117]: E2E User
          - generic [ref=e118]: pw-e2e-admin@weaveintel.dev
      - generic [ref=e119]: ◷ Tue, Apr 21
      - textbox "Search chats..." [ref=e121]
      - generic [ref=e122]:
        - button "+ New Chat" [ref=e123] [cursor=pointer]
        - button "E2E User" [ref=e125] [cursor=pointer]:
          - img "E2E User" [ref=e126]
    - generic [ref=e127]:
      - heading "Administration" [level=2] [ref=e128]
      - generic [ref=e129]: Tenant Configs
      - generic [ref=e130]:
        - navigation "Breadcrumb" [ref=e131]:
          - button "←" [ref=e132] [cursor=pointer]
          - list [ref=e133]:
            - listitem [ref=e134]:
              - button "Tenant Configs" [ref=e135] [cursor=pointer]
            - listitem [ref=e136]: › New Tenant Config
        - generic [ref=e138]:
          - generic [ref=e139]:
            - generic [ref=e140]: New Tenant Config
            - generic [ref=e141]:
              - button "Cancel" [ref=e142] [cursor=pointer]
              - button "Create" [ref=e143] [cursor=pointer]
          - generic [ref=e144]:
            - generic [ref=e145]: Name
            - textbox [ref=e146]
          - generic [ref=e147]:
            - generic [ref=e148]: Description
            - textbox [ref=e149]
          - generic [ref=e150]:
            - generic [ref=e151]: Tenant ID
            - textbox [ref=e152]
          - generic [ref=e153]:
            - generic [ref=e154]: Scope
            - combobox [ref=e155]:
              - option "tenant" [selected]
              - option "user"
              - option "team"
          - generic [ref=e156]:
            - generic [ref=e157]: Allowed Models (JSON)
            - textbox [ref=e158]
          - generic [ref=e159]:
            - generic [ref=e160]: Denied Models (JSON)
            - textbox [ref=e161]
          - generic [ref=e162]:
            - generic [ref=e163]: Allowed Tools (JSON)
            - textbox [ref=e164]
          - generic [ref=e165]:
            - generic [ref=e166]: Max Tokens/Day
            - spinbutton [ref=e167]
          - generic [ref=e168]:
            - generic [ref=e169]: Max Cost/Day
            - spinbutton [ref=e170]
          - generic [ref=e171]:
            - generic [ref=e172]: Max Tokens/Month
            - spinbutton [ref=e173]
          - generic [ref=e174]:
            - generic [ref=e175]: Max Cost/Month
            - spinbutton [ref=e176]
          - generic [ref=e177]:
            - generic [ref=e178]: Features (JSON)
            - textbox [ref=e179]
          - generic [ref=e180]:
            - generic [ref=e181]: Config Overrides (JSON)
            - textbox [ref=e182]
          - generic [ref=e183]:
            - generic [ref=e184]: Enabled
            - checkbox [checked] [ref=e185]
```

# Test source

```ts
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
  1012 |     await seedDefaults(page);
  1013 |     await page.waitForTimeout(1500);
  1014 |     await openAdminTab(page, 'Tenants');
  1015 |     await clickAdminNewButton(m);
  1016 |     await page.waitForTimeout(300);
> 1017 |     await expect(m.locator('h3', { hasText: 'New Tenant Config' })).toBeVisible({ timeout: 3000 });
       |                                                                     ^ Error: expect(locator).toBeVisible() failed
  1018 |     const textInputs = m.locator('input[type="text"]');
  1019 |     await textInputs.nth(0).fill('PW-Test-Tenant');
  1020 |     await textInputs.nth(2).fill('pw-tenant-id');
  1021 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  1022 |     await expect(m.locator('h3', { hasText: 'New Tenant Config' })).not.toBeVisible({ timeout: 5000 });
  1023 |   });
  1024 | 
  1025 |   test('edits a seeded tenant config', async ({ page }) => {
  1026 |     await registerAndEnter(page);
  1027 |     await goAdmin(page);
  1028 |     const m = main(page);
  1029 |     await seedDefaults(page);
  1030 |     await page.waitForTimeout(1500);
  1031 |     await openAdminTab(page, 'Tenants');
  1032 |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  1033 |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  1034 |       await editBtn.click();
  1035 |       await page.waitForTimeout(300);
  1036 |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  1037 |     }
  1038 |   });
  1039 | });
  1040 | 
  1041 | // ─── Admin Sandbox Policies ─────────────────────────────────
  1042 | 
  1043 | test.describe('Admin Sandbox Policies', () => {
  1044 |   test('shows seeded sandbox policies', async ({ page }) => {
  1045 |     await registerAndEnter(page);
  1046 |     await goAdmin(page);
  1047 |     const m = main(page);
  1048 |     await seedDefaults(page);
  1049 |     await page.waitForTimeout(1500);
  1050 |     await openAdminTab(page, 'Sandbox');
  1051 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  1052 |   });
  1053 | 
  1054 |   test('creates a new sandbox policy via form', async ({ page }) => {
  1055 |     await registerAndEnter(page);
  1056 |     await goAdmin(page);
  1057 |     const m = main(page);
  1058 |     await seedDefaults(page);
  1059 |     await page.waitForTimeout(1500);
  1060 |     await openAdminTab(page, 'Sandbox');
  1061 |     await clickAdminNewButton(m);
  1062 |     await page.waitForTimeout(300);
  1063 |     await expect(m.locator('h3', { hasText: 'New Sandbox Policy' })).toBeVisible({ timeout: 3000 });
  1064 |     const textInputs = m.locator('input[type="text"]');
  1065 |     await textInputs.nth(0).fill('PW-Sandbox');
  1066 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  1067 |     await expect(m.locator('h3', { hasText: 'New Sandbox Policy' })).not.toBeVisible({ timeout: 5000 });
  1068 |   });
  1069 | 
  1070 |   test('edits a seeded sandbox policy', async ({ page }) => {
  1071 |     await registerAndEnter(page);
  1072 |     await goAdmin(page);
  1073 |     const m = main(page);
  1074 |     await seedDefaults(page);
  1075 |     await page.waitForTimeout(1500);
  1076 |     await openAdminTab(page, 'Sandbox');
  1077 |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  1078 |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  1079 |       await editBtn.click();
  1080 |       await page.waitForTimeout(300);
  1081 |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  1082 |     }
  1083 |   });
  1084 | });
  1085 | 
  1086 | // ─── Admin Extraction Pipelines ─────────────────────────────
  1087 | 
  1088 | test.describe('Admin Extraction Pipelines', () => {
  1089 |   test('shows seeded extraction pipelines', async ({ page }) => {
  1090 |     await registerAndEnter(page);
  1091 |     await goAdmin(page);
  1092 |     const m = main(page);
  1093 |     await seedDefaults(page);
  1094 |     await page.waitForTimeout(1500);
  1095 |     await openAdminTab(page, 'Extraction');
  1096 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  1097 |   });
  1098 | 
  1099 |   test('creates a new extraction pipeline via form', async ({ page }) => {
  1100 |     await registerAndEnter(page);
  1101 |     await goAdmin(page);
  1102 |     const m = main(page);
  1103 |     await seedDefaults(page);
  1104 |     await page.waitForTimeout(1500);
  1105 |     await openAdminTab(page, 'Extraction');
  1106 |     await clickAdminNewButton(m);
  1107 |     await page.waitForTimeout(300);
  1108 |     await expect(m.locator('h3', { hasText: 'New Extraction Pipeline' })).toBeVisible({ timeout: 3000 });
  1109 |     const textInputs = m.locator('input[type="text"]');
  1110 |     await textInputs.nth(0).fill('PW-Pipeline');
  1111 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  1112 |     await expect(m.locator('h3', { hasText: 'New Extraction Pipeline' })).not.toBeVisible({ timeout: 5000 });
  1113 |   });
  1114 | 
  1115 |   test('edits a seeded extraction pipeline', async ({ page }) => {
  1116 |     await registerAndEnter(page);
  1117 |     await goAdmin(page);
```