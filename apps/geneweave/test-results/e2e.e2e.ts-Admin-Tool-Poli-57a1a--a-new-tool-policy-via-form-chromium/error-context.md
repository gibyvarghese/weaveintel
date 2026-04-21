# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e.e2e.ts >> Admin Tool Policies >> creates a new tool policy via form
- Location: src/e2e.e2e.ts:817:3

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
      - generic [ref=e139]: Tool Policys
      - generic [ref=e140]:
        - navigation "Breadcrumb" [ref=e141]:
          - button "←" [ref=e142] [cursor=pointer]
          - list [ref=e143]:
            - listitem [ref=e144]:
              - button "Tool Policys" [ref=e145] [cursor=pointer]
            - listitem [ref=e146]: › New Tool Policy
        - generic [ref=e148]:
          - generic [ref=e149]:
            - generic [ref=e150]: New Tool Policy
            - generic [ref=e151]:
              - button "Cancel" [ref=e152] [cursor=pointer]
              - button "Create" [ref=e153] [cursor=pointer]
          - generic [ref=e154]:
            - generic [ref=e155]: Policy Key (unique identifier, used in skill tool_policy_key)
            - textbox [ref=e156]
          - generic [ref=e157]:
            - generic [ref=e158]: Name
            - textbox [ref=e159]
          - generic [ref=e160]:
            - generic [ref=e161]: Description (when to apply this policy)
            - textbox [ref=e162]
          - generic [ref=e163]:
            - generic [ref=e164]: Applies To (JSON array of tool names / wildcards)
            - textbox [ref=e165]
          - generic [ref=e166]:
            - generic [ref=e167]: Applies To Risk Levels (JSON array)
            - textbox [ref=e168]
          - generic [ref=e169]:
            - generic [ref=e170]: Allowed Risk Levels (JSON array)
            - textbox [ref=e171]
          - generic [ref=e172]:
            - generic [ref=e173]: Approval Required
            - checkbox [ref=e174]
          - generic [ref=e175]:
            - generic [ref=e176]: Rate Limit / min
            - spinbutton [ref=e177]
          - generic [ref=e178]:
            - generic [ref=e179]: Max Execution (ms)
            - spinbutton [ref=e180]
          - generic [ref=e181]:
            - generic [ref=e182]: Max Concurrent
            - spinbutton [ref=e183]
          - generic [ref=e184]:
            - generic [ref=e185]: Require Dry Run
            - checkbox [ref=e186]
          - generic [ref=e187]:
            - generic [ref=e188]: Log I/O
            - checkbox [checked] [ref=e189]
          - generic [ref=e190]:
            - generic [ref=e191]: Persona Scope (JSON array of persona strings)
            - textbox [ref=e192]
          - generic [ref=e193]:
            - generic [ref=e194]: "Active Hours UTC (JSON { \"start\":\"HH:MM\",\"end\":\"HH:MM\" })"
            - textbox [ref=e195]
          - generic [ref=e196]:
            - generic [ref=e197]: Expires At (ISO datetime, optional)
            - textbox [ref=e198]
          - generic [ref=e199]:
            - generic [ref=e200]: Enabled
            - checkbox [checked] [ref=e201]
```

# Test source

```ts
  726 |     const m = main(page);
  727 |     await seedDefaults(page);
  728 |     await page.waitForTimeout(1500);
  729 |     await openAdminTab(page, 'Enterprise');
  730 |     await clickAdminNewButton(m);
  731 |     await page.waitForTimeout(300);
  732 |     await expect(m.locator('h3', { hasText: 'New Enterprise Connector' })).toBeVisible({ timeout: 3000 });
  733 |     await m.locator('input[type="text"]').first().fill('PW-Test-Enterprise');
  734 |     const selects = m.locator('select');
  735 |     if ((await selects.count()) > 0) {
  736 |       await selects.first().selectOption({ index: 1 });
  737 |     }
  738 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  739 |     await expect(m.locator('h3', { hasText: 'New Enterprise Connector' })).not.toBeVisible({ timeout: 5000 });
  740 |   });
  741 | 
  742 |   test('edits a seeded enterprise connector', async ({ page }) => {
  743 |     await registerAndEnter(page);
  744 |     await goAdmin(page);
  745 |     const m = main(page);
  746 |     await seedDefaults(page);
  747 |     await page.waitForTimeout(1500);
  748 |     await openAdminTab(page, 'Enterprise');
  749 |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  750 |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  751 |       await editBtn.click();
  752 |       await page.waitForTimeout(300);
  753 |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  754 |     }
  755 |   });
  756 | });
  757 | 
  758 | /* ── Admin: Tool Catalog Tab ─────────────────────────────── */
  759 | 
  760 | test.describe('Admin Tool Catalog', () => {
  761 |   test('tool catalog tab shows seeded data', async ({ page }) => {
  762 |     await registerAndEnter(page);
  763 |     await goAdmin(page);
  764 |     const m = main(page);
  765 |     await seedDefaults(page);
  766 |     await page.waitForTimeout(1500);
  767 |     await openAdminTab(page, 'Tools');
  768 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  769 |   });
  770 | 
  771 |   test('creates a new tool catalog entry via form', async ({ page }) => {
  772 |     await registerAndEnter(page);
  773 |     await goAdmin(page);
  774 |     const m = main(page);
  775 |     await seedDefaults(page);
  776 |     await page.waitForTimeout(1500);
  777 |     await openAdminTab(page, 'Tools');
  778 |     await clickAdminNewButton(m);
  779 |     await page.waitForTimeout(300);
  780 |     await expect(m.locator('h3', { hasText: 'New Tool' })).toBeVisible({ timeout: 3000 });
  781 |     const inputs = m.locator('input[type="text"]');
  782 |     await inputs.nth(0).fill('PW-Test-Tool');
  783 |     await inputs.nth(1).fill('pw-test-tool');
  784 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  785 |     await expect(m.locator('h3', { hasText: 'New Tool' })).not.toBeVisible({ timeout: 5000 });
  786 |   });
  787 | 
  788 |   test('edits a seeded tool catalog entry', async ({ page }) => {
  789 |     await registerAndEnter(page);
  790 |     await goAdmin(page);
  791 |     const m = main(page);
  792 |     await seedDefaults(page);
  793 |     await page.waitForTimeout(1500);
  794 |     await openAdminTab(page, 'Tools');
  795 |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  796 |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  797 |       await editBtn.click();
  798 |       await page.waitForTimeout(300);
  799 |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  800 |     }
  801 |   });
  802 | });
  803 | 
  804 | /* ── Admin: Tool Policies Tab ────────────────────────────── */
  805 | 
  806 | test.describe('Admin Tool Policies', () => {
  807 |   test('tool policies tab shows seeded data', async ({ page }) => {
  808 |     await registerAndEnter(page);
  809 |     await goAdmin(page);
  810 |     const m = main(page);
  811 |     await seedDefaults(page);
  812 |     await page.waitForTimeout(1500);
  813 |     await openAdminTab(page, 'Tool Policies');
  814 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  815 |   });
  816 | 
  817 |   test('creates a new tool policy via form', async ({ page }) => {
  818 |     await registerAndEnter(page);
  819 |     await goAdmin(page);
  820 |     const m = main(page);
  821 |     await seedDefaults(page);
  822 |     await page.waitForTimeout(1500);
  823 |     await openAdminTab(page, 'Tool Policies');
  824 |     await clickAdminNewButton(m);
  825 |     await page.waitForTimeout(300);
> 826 |     await expect(m.locator('h3', { hasText: 'New Tool Policy' })).toBeVisible({ timeout: 3000 });
      |                                                                   ^ Error: expect(locator).toBeVisible() failed
  827 |     const inputs = m.locator('input[type="text"]');
  828 |     await inputs.nth(0).fill('pw-test-policy');
  829 |     await inputs.nth(1).fill('PW Test Policy');
  830 |     await m.locator('button.nav-btn', { hasText: 'Create' }).click();
  831 |     await expect(m.locator('h3', { hasText: 'New Tool Policy' })).not.toBeVisible({ timeout: 5000 });
  832 |   });
  833 | 
  834 |   test('edits a seeded tool policy', async ({ page }) => {
  835 |     await registerAndEnter(page);
  836 |     await goAdmin(page);
  837 |     const m = main(page);
  838 |     await seedDefaults(page);
  839 |     await page.waitForTimeout(1500);
  840 |     await openAdminTab(page, 'Tool Policies');
  841 |     const editBtn = m.locator('button', { hasText: 'Edit' }).first();
  842 |     if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  843 |       await editBtn.click();
  844 |       await page.waitForTimeout(300);
  845 |       await expect(m.getByRole('heading', { name: /^Edit / })).toBeVisible({ timeout: 3000 });
  846 |     }
  847 |   });
  848 | });
  849 | 
  850 | /* ── Admin: Tool Audit Tab ───────────────────────────────── */
  851 | 
  852 | test.describe('Admin Tool Audit', () => {
  853 |   test('tool audit tab is visible and shows empty state or list', async ({ page }) => {
  854 |     await registerAndEnter(page);
  855 |     await goAdmin(page);
  856 |     const m = main(page);
  857 |     await seedDefaults(page);
  858 |     await page.waitForTimeout(1500);
  859 |     await openAdminTab(page, 'Tool Audit');
  860 |     // Tab loaded — either empty state or item list is acceptable (no events yet in fresh DB)
  861 |     await expect(m).toBeVisible();
  862 |   });
  863 | 
  864 |   test('tool audit tab has no New button (read-only)', async ({ page }) => {
  865 |     await registerAndEnter(page);
  866 |     await goAdmin(page);
  867 |     const m = main(page);
  868 |     await seedDefaults(page);
  869 |     await page.waitForTimeout(1500);
  870 |     await openAdminTab(page, 'Tool Audit');
  871 |     await page.waitForTimeout(500);
  872 |     await expect(m.locator('button', { hasText: 'New Tool Audit Event' })).not.toBeVisible();
  873 |   });
  874 | });
  875 | 
  876 | /* ── Admin: Tool Health Tab ──────────────────────────────── */
  877 | 
  878 | test.describe('Admin Tool Health', () => {
  879 |   test('tool health tab is visible and shows empty state or list', async ({ page }) => {
  880 |     await registerAndEnter(page);
  881 |     await goAdmin(page);
  882 |     const m = main(page);
  883 |     await seedDefaults(page);
  884 |     await page.waitForTimeout(1500);
  885 |     await openAdminTab(page, 'Tool Health');
  886 |     await expect(m).toBeVisible();
  887 |   });
  888 | 
  889 |   test('tool health tab has no New button (read-only)', async ({ page }) => {
  890 |     await registerAndEnter(page);
  891 |     await goAdmin(page);
  892 |     const m = main(page);
  893 |     await seedDefaults(page);
  894 |     await page.waitForTimeout(1500);
  895 |     await openAdminTab(page, 'Tool Health');
  896 |     await page.waitForTimeout(500);
  897 |     await expect(m.locator('button', { hasText: 'New Tool Health' })).not.toBeVisible();
  898 |   });
  899 | });
  900 | 
  901 | /* ── Admin: Replay Scenarios Tab ─────────────────────────── */
  902 | 
  903 | test.describe('Admin Replay Scenarios', () => {
  904 |   test('replay tab shows seeded data', async ({ page }) => {
  905 |     await registerAndEnter(page);
  906 |     await goAdmin(page);
  907 |     const m = main(page);
  908 |     await seedDefaults(page);
  909 |     await page.waitForTimeout(1500);
  910 |     await openAdminTab(page, 'Replay');
  911 |     await expect(m.getByText(/[1-9]\d* items?/)).toBeVisible({ timeout: 5000 });
  912 |   });
  913 | 
  914 |   test('creates a new replay scenario via form', async ({ page }) => {
  915 |     await registerAndEnter(page);
  916 |     await goAdmin(page);
  917 |     const m = main(page);
  918 |     await seedDefaults(page);
  919 |     await page.waitForTimeout(1500);
  920 |     await openAdminTab(page, 'Replay');
  921 |     await clickAdminNewButton(m);
  922 |     await page.waitForTimeout(300);
  923 |     await expect(m.locator('h3', { hasText: 'New Replay Scenario' })).toBeVisible({ timeout: 3000 });
  924 |     const textInputs = m.locator('input[type="text"]');
  925 |     await textInputs.nth(0).fill('PW-Test-Replay');
  926 |     const textareas = m.locator('textarea');
```