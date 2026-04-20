# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e.e2e.ts >> Admin Tool Policies >> creates a new tool policy via form
- Location: src/e2e.e2e.ts:814:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.main').locator('h3').filter({ hasText: 'New Tool Policy' })
Expected: visible
Timeout: 3000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 3000ms
  - waiting for locator('.main').locator('h3').filter({ hasText: 'New Tool Policy' })

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
              - button "Workflows" [ref=e70] [cursor=pointer]
              - button "Routing" [ref=e71] [cursor=pointer]
              - button "Task Policies" [ref=e72] [cursor=pointer]
              - button "Triggers" [ref=e73] [cursor=pointer]
              - button "Replay" [ref=e74] [cursor=pointer]
            - button "Governance ▾" [ref=e75] [cursor=pointer]:
              - generic [ref=e76]: Governance
              - generic [ref=e77]: ▾
            - button "Integrations ▾" [ref=e78] [cursor=pointer]:
              - generic [ref=e79]: Integrations
              - generic [ref=e80]: ▾
            - button "Knowledge ▾" [ref=e81] [cursor=pointer]:
              - generic [ref=e82]: Knowledge
              - generic [ref=e83]: ▾
            - button "Infrastructure ▾" [ref=e84] [cursor=pointer]:
              - generic [ref=e85]: Infrastructure
              - generic [ref=e86]: ▾
            - button "Monitoring ▾" [ref=e87] [cursor=pointer]:
              - generic [ref=e88]: Monitoring
              - generic [ref=e89]: ▾
            - button "Developer ▾" [ref=e90] [cursor=pointer]:
              - generic [ref=e91]: Developer
              - generic [ref=e92]: ▾
      - generic:
        - button "Recent Chats ▾" [ref=e93] [cursor=pointer]:
          - generic [ref=e94]: Recent Chats
          - generic [ref=e95]: ▾
        - generic [ref=e96]: No saved chats yet
  - generic [ref=e97]:
    - generic [ref=e99]:
      - generic [ref=e100]:
        - img "E2E User" [ref=e101]
        - generic [ref=e102]:
          - generic [ref=e103]: E2E User
          - generic [ref=e104]: pw-e2e-admin@weaveintel.dev
      - generic [ref=e105]: ◷ Tue, Apr 21
      - textbox "Search chats..." [ref=e107]
      - generic [ref=e108]:
        - button "+ New Chat" [ref=e109] [cursor=pointer]
        - button "E2E User" [ref=e111] [cursor=pointer]:
          - img "E2E User" [ref=e112]
    - generic [ref=e113]:
      - heading "Administration" [level=2] [ref=e114]
      - generic [ref=e115]: Tool Policys
      - generic [ref=e116]:
        - navigation "Breadcrumb" [ref=e117]:
          - button "←" [ref=e118] [cursor=pointer]
          - list [ref=e119]:
            - listitem [ref=e120]:
              - button "Tool Policys" [ref=e121] [cursor=pointer]
            - listitem [ref=e122]: › New Tool Policy
        - generic [ref=e124]:
          - generic [ref=e125]:
            - generic [ref=e126]: New Tool Policy
            - generic [ref=e127]:
              - button "Cancel" [ref=e128] [cursor=pointer]
              - button "Create" [ref=e129] [cursor=pointer]
          - generic [ref=e130]:
            - generic [ref=e131]: Policy Key (unique identifier, used in skill tool_policy_key)
            - textbox [ref=e132]
          - generic [ref=e133]:
            - generic [ref=e134]: Name
            - textbox [ref=e135]
          - generic [ref=e136]:
            - generic [ref=e137]: Description (when to apply this policy)
            - textbox [ref=e138]
          - generic [ref=e139]:
            - generic [ref=e140]: Applies To (JSON array of tool names / wildcards)
            - textbox [ref=e141]
          - generic [ref=e142]:
            - generic [ref=e143]: Applies To Risk Levels (JSON array)
            - textbox [ref=e144]
          - generic [ref=e145]:
            - generic [ref=e146]: Allowed Risk Levels (JSON array)
            - textbox [ref=e147]
          - generic [ref=e148]:
            - generic [ref=e149]: Approval Required
            - checkbox [ref=e150]
          - generic [ref=e151]:
            - generic [ref=e152]: Rate Limit / min
            - spinbutton [ref=e153]
          - generic [ref=e154]:
            - generic [ref=e155]: Max Execution (ms)
            - spinbutton [ref=e156]
          - generic [ref=e157]:
            - generic [ref=e158]: Max Concurrent
            - spinbutton [ref=e159]
          - generic [ref=e160]:
            - generic [ref=e161]: Require Dry Run
            - checkbox [ref=e162]
          - generic [ref=e163]:
            - generic [ref=e164]: Log I/O
            - checkbox [checked] [ref=e165]
          - generic [ref=e166]:
            - generic [ref=e167]: Persona Scope (JSON array of persona strings)
            - textbox [ref=e168]
          - generic [ref=e169]:
            - generic [ref=e170]: "Active Hours UTC (JSON { \"start\":\"HH:MM\",\"end\":\"HH:MM\" })"
            - textbox [ref=e171]
          - generic [ref=e172]:
            - generic [ref=e173]: Expires At (ISO datetime, optional)
            - textbox [ref=e174]
          - generic [ref=e175]:
            - generic [ref=e176]: Enabled
            - checkbox [checked] [ref=e177]
```

# Test source

```ts
  723 |     const m = main(page);
  724 |     await seedDefaults(page);
  725 |     await page.waitForTimeout(1500);
  726 |     await openAdminTab(page, 'Enterprise');
  727 |     await clickAdminNewButton(m);
  728 |     await page.waitForTimeout(300);
  729 |     await expect(m.locator('h3', { hasText: 'New Enterprise Connector' })).toBeVisible({ timeout: 3000 });
  730 |     await m.locator('input[type="text"]').first().fill('PW-Test-Enterprise');
  731 |     const selects = m.locator('select');
  732 |     if ((await selects.count()) > 0) {
  733 |       await selects.first().selectOption({ index: 1 });
  734 |     }
  735 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  736 |     await expect(m.locator('h3', { hasText: 'New Enterprise Connector' })).not.toBeVisible({ timeout: 5000 });
  737 |   });
  738 | 
  739 |   test('edits a seeded enterprise connector', async ({ page }) => {
  740 |     await registerAndEnter(page);
  741 |     await goAdmin(page);
  742 |     const m = main(page);
  743 |     await seedDefaults(page);
  744 |     await page.waitForTimeout(1500);
  745 |     await openAdminTab(page, 'Enterprise');
  746 |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  747 |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  748 |       await editBtn.click();
  749 |       await page.waitForTimeout(300);
  750 |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  751 |     }
  752 |   });
  753 | });
  754 | 
  755 | /* ── Admin: Tool Catalog Tab ─────────────────────────────── */
  756 | 
  757 | test.describe('Admin Tool Catalog', () => {
  758 |   test('tool catalog tab shows seeded data', async ({ page }) => {
  759 |     await registerAndEnter(page);
  760 |     await goAdmin(page);
  761 |     const m = main(page);
  762 |     await seedDefaults(page);
  763 |     await page.waitForTimeout(1500);
  764 |     await openAdminTab(page, 'Tools');
  765 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  766 |   });
  767 | 
  768 |   test('creates a new tool catalog entry via form', async ({ page }) => {
  769 |     await registerAndEnter(page);
  770 |     await goAdmin(page);
  771 |     const m = main(page);
  772 |     await seedDefaults(page);
  773 |     await page.waitForTimeout(1500);
  774 |     await openAdminTab(page, 'Tools');
  775 |     await clickAdminNewButton(m);
  776 |     await page.waitForTimeout(300);
  777 |     await expect(m.locator('h3', { hasText: 'New Tool' })).toBeVisible({ timeout: 3000 });
  778 |     const inputs = m.locator('input[type="text"]');
  779 |     await inputs.nth(0).fill('PW-Test-Tool');
  780 |     await inputs.nth(1).fill('pw-test-tool');
  781 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  782 |     await expect(m.locator('h3', { hasText: 'New Tool' })).not.toBeVisible({ timeout: 5000 });
  783 |   });
  784 | 
  785 |   test('edits a seeded tool catalog entry', async ({ page }) => {
  786 |     await registerAndEnter(page);
  787 |     await goAdmin(page);
  788 |     const m = main(page);
  789 |     await seedDefaults(page);
  790 |     await page.waitForTimeout(1500);
  791 |     await openAdminTab(page, 'Tools');
  792 |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  793 |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  794 |       await editBtn.click();
  795 |       await page.waitForTimeout(300);
  796 |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  797 |     }
  798 |   });
  799 | });
  800 | 
  801 | /* ── Admin: Tool Policies Tab ────────────────────────────── */
  802 | 
  803 | test.describe('Admin Tool Policies', () => {
  804 |   test('tool policies tab shows seeded data', async ({ page }) => {
  805 |     await registerAndEnter(page);
  806 |     await goAdmin(page);
  807 |     const m = main(page);
  808 |     await seedDefaults(page);
  809 |     await page.waitForTimeout(1500);
  810 |     await openAdminTab(page, 'Tool Policies');
  811 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  812 |   });
  813 | 
  814 |   test('creates a new tool policy via form', async ({ page }) => {
  815 |     await registerAndEnter(page);
  816 |     await goAdmin(page);
  817 |     const m = main(page);
  818 |     await seedDefaults(page);
  819 |     await page.waitForTimeout(1500);
  820 |     await openAdminTab(page, 'Tool Policies');
  821 |     await clickAdminNewButton(m);
  822 |     await page.waitForTimeout(300);
> 823 |     await expect(m.locator('h3', { hasText: 'New Tool Policy' })).toBeVisible({ timeout: 3000 });
      |                                                                   ^ Error: expect(locator).toBeVisible() failed
  824 |     const inputs = m.locator('input[type="text"]');
  825 |     await inputs.nth(0).fill('pw-test-policy');
  826 |     await inputs.nth(1).fill('PW Test Policy');
  827 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  828 |     await expect(m.locator('h3', { hasText: 'New Tool Policy' })).not.toBeVisible({ timeout: 5000 });
  829 |   });
  830 | 
  831 |   test('edits a seeded tool policy', async ({ page }) => {
  832 |     await registerAndEnter(page);
  833 |     await goAdmin(page);
  834 |     const m = main(page);
  835 |     await seedDefaults(page);
  836 |     await page.waitForTimeout(1500);
  837 |     await openAdminTab(page, 'Tool Policies');
  838 |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  839 |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  840 |       await editBtn.click();
  841 |       await page.waitForTimeout(300);
  842 |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  843 |     }
  844 |   });
  845 | });
  846 | 
  847 | /* ── Admin: Replay Scenarios Tab ─────────────────────────── */
  848 | 
  849 | test.describe('Admin Replay Scenarios', () => {
  850 |   test('replay tab shows seeded data', async ({ page }) => {
  851 |     await registerAndEnter(page);
  852 |     await goAdmin(page);
  853 |     const m = main(page);
  854 |     await seedDefaults(page);
  855 |     await page.waitForTimeout(1500);
  856 |     await openAdminTab(page, 'Replay');
  857 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  858 |   });
  859 | 
  860 |   test('creates a new replay scenario via form', async ({ page }) => {
  861 |     await registerAndEnter(page);
  862 |     await goAdmin(page);
  863 |     const m = main(page);
  864 |     await seedDefaults(page);
  865 |     await page.waitForTimeout(1500);
  866 |     await openAdminTab(page, 'Replay');
  867 |     await clickAdminNewButton(m);
  868 |     await page.waitForTimeout(300);
  869 |     await expect(m.locator('h3', { hasText: 'New Replay Scenario' })).toBeVisible({ timeout: 3000 });
  870 |     const textInputs = m.locator('input[type="text"]');
  871 |     await textInputs.nth(0).fill('PW-Test-Replay');
  872 |     const textareas = m.locator('textarea');
  873 |     await textareas.nth(0).fill('What is 1+1?');
  874 |     await textareas.nth(1).fill('The answer is 2.');
  875 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  876 |     await expect(m.locator('h3', { hasText: 'New Replay Scenario' })).not.toBeVisible({ timeout: 5000 });
  877 |   });
  878 | 
  879 |   test('edits a seeded replay scenario', async ({ page }) => {
  880 |     await registerAndEnter(page);
  881 |     await goAdmin(page);
  882 |     const m = main(page);
  883 |     await seedDefaults(page);
  884 |     await page.waitForTimeout(1500);
  885 |     await openAdminTab(page, 'Replay');
  886 |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  887 |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  888 |       await editBtn.click();
  889 |       await page.waitForTimeout(300);
  890 |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  891 |     }
  892 |   });
  893 | });
  894 | 
  895 | /* ── Admin: Trigger Definitions Tab ──────────────────────── */
  896 | 
  897 | test.describe('Admin Trigger Definitions', () => {
  898 |   test('triggers tab shows seeded data', async ({ page }) => {
  899 |     await registerAndEnter(page);
  900 |     await goAdmin(page);
  901 |     const m = main(page);
  902 |     await seedDefaults(page);
  903 |     await page.waitForTimeout(1500);
  904 |     await openAdminTab(page, 'Triggers');
  905 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  906 |   });
  907 | 
  908 |   test('creates a new trigger definition via form', async ({ page }) => {
  909 |     await registerAndEnter(page);
  910 |     await goAdmin(page);
  911 |     const m = main(page);
  912 |     await seedDefaults(page);
  913 |     await page.waitForTimeout(1500);
  914 |     await openAdminTab(page, 'Triggers');
  915 |     await clickAdminNewButton(m);
  916 |     await page.waitForTimeout(300);
  917 |     await expect(m.locator('h3', { hasText: 'New Trigger Definition' })).toBeVisible({ timeout: 3000 });
  918 |     const textInputs = m.locator('input[type="text"]');
  919 |     await textInputs.nth(0).fill('PW-Test-Trigger');
  920 |     await textInputs.nth(1).fill('0 6 * * *');
  921 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  922 |     await expect(m.locator('h3', { hasText: 'New Trigger Definition' })).not.toBeVisible({ timeout: 5000 });
  923 |   });
```