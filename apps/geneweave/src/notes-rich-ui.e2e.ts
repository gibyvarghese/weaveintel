/**
 * Notes UI fidelity — the rich-text toolbar + the notebook folder tree (design: "GeneWeave Notes.dc.html").
 *
 *  • Toolbar — opening a note shows the full formatting strip (undo/redo, a Text-style dropdown, B/I/U/S,
 *    link, text colour, highlights, lists), not just B/I/U. The block-type menu opens with all block types.
 *  • Folders — sub-notes (parent_note_id) render as an expandable notebook TREE in the left rail; a folder
 *    collapses to hide its children; a hover "+" creates a sub-note.
 *
 * Run: npm run test:e2e -- notes-rich-ui
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Str0ng!Pass99';

async function login(page: Page, email: string): Promise<{ H: Record<string, string> }> {
  await page.request.post('/api/auth/register', { data: { name: email.split('@')[0], email, password: PW } });
  await page.request.post('/api/auth/login', { data: { email, password: PW } });
  await page.goto('/');
  await expect(page.locator('.workspace-nav')).toBeVisible({ timeout: 15000 });
  const me = await (await page.request.get('/api/auth/me')).json() as { csrfToken?: string };
  return { H: { 'x-csrf-token': me.csrfToken ?? '', 'content-type': 'application/json' } };
}
async function goNotes(page: Page): Promise<void> {
  await page.evaluate(() => { const w = window as any; if (w.state) w.state.view = 'notes'; if (w.render) w.render(); });
  // Load the notes list via the module's exported loader. The specifier is held in a variable so the
  // TypeScript build doesn't try to resolve this browser-runtime path (it only exists at runtime, served).
  await page.evaluate(async () => { const spec = '/ui/notes-view.js'; const m = await import(/* @vite-ignore */ spec); await (m as any).loadNotesList(); (window as any).render?.(); });
  await page.waitForTimeout(600);
}

test('Notes toolbar — the full rich-text formatting strip renders', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { H } = await login(page, 'notes-rich@weaveintel.dev');
  const doc = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Format me.' }] }] });
  await page.request.post('/api/me/notes', { headers: H, data: { title: 'Toolbar note', doc_json: doc } });
  await goNotes(page);
  await page.locator('.gw-tree-row', { hasText: 'Toolbar note' }).first().click();
  await expect(page.locator('.gw-toolstrip')).toBeVisible({ timeout: 8000 });

  // The rich controls are all present (not just B/I/U).
  await expect(page.locator('.gw-block-btn')).toBeVisible();
  await expect(page.locator('.gw-toolstrip [title="Undo"]')).toBeVisible();
  await expect(page.locator('.gw-toolstrip [title="Redo"]')).toBeVisible();
  for (const c of ['.gw-tool-b', '.gw-tool-i', '.gw-tool-u', '.gw-tool-s']) await expect(page.locator(c)).toBeVisible();
  await expect(page.locator('.gw-toolstrip [title="Link"]')).toBeVisible();
  await expect(page.locator('.gw-toolstrip [title="Text colour"]')).toBeVisible();
  await expect(page.locator('.gw-toolstrip [title="Bulleted list"]')).toBeVisible();
  await expect(page.locator('.gw-toolstrip [title="To-do list"]')).toBeVisible();

  // The block-type menu opens with every block type.
  await page.locator('.gw-block-btn').click();
  await expect(page.locator('.gw-block-menu')).toBeVisible();
  for (const label of ['Heading 1', 'Bulleted list', 'To-do list', 'Quote', 'Code block', 'Divider']) {
    await expect(page.locator('.gw-block-menu', { hasText: label })).toBeVisible();
  }
});

test('Notes toolbar — the 1/2/3 column layout control applies to the editor body', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { H } = await login(page, 'notes-cols@weaveintel.dev');
  const paras = Array.from({ length: 6 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Para ${i + 1} with enough words to flow across columns nicely.` }] }));
  const doc = JSON.stringify({ type: 'doc', content: paras });
  await page.request.post('/api/me/notes', { headers: H, data: { title: 'Cols note', doc_json: doc } });
  await goNotes(page);
  await page.locator('.gw-tree-row', { hasText: 'Cols note' }).first().click();
  await expect(page.locator('.gw-cols-seg')).toBeVisible({ timeout: 8000 });
  expect(await page.locator('.gw-cols-btn').count()).toBe(3);

  // Default is a single column; the editor body has no forced column-count.
  expect(await page.locator('.gw-canvas').getAttribute('data-cols')).toBe('1');

  // Click "two columns" → the canvas flips to data-cols=2 and the editor body computes 2 columns.
  await page.locator('.gw-cols-btn').nth(1).click();
  await page.waitForTimeout(300);
  expect(await page.locator('.gw-canvas').getAttribute('data-cols')).toBe('2');
  const cc = await page.evaluate(() => {
    const el = document.querySelector('.notes-editor-mount [contenteditable]');
    return el ? getComputedStyle(el).columnCount : 'none';
  });
  expect(cc).toBe('2');
});

test('Notes rail — sub-notes render as an expandable notebook folder tree', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { H } = await login(page, 'notes-folders@weaveintel.dev');
  const mk = async (title: string, parent?: string, icon?: string): Promise<string> =>
    (await (await page.request.post('/api/me/notes', { headers: H, data: { title, ...(parent ? { parent_note_id: parent } : {}), ...(icon ? { icon } : {}) } })).json() as { id: string }).id;
  const work = await mk('Work', undefined, '💼');
  await mk('Matter & its states', work);
  await mk('Standup notes', work);
  await mk('Ideas', work);
  await goNotes(page);

  // The folder shows a caret and nests its children.
  await expect(page.locator('.gw-tree-caret:not(.gw-tree-caret-none)')).toHaveCount(1);
  await expect(page.locator('.gw-tree-nest')).toHaveCount(1);
  expect(await page.locator('.gw-tree-child').count()).toBe(3);

  // Collapsing the folder hides its children.
  await page.locator('.gw-tree-row', { hasText: 'Work' }).locator('.gw-tree-caret').first().click();
  await page.waitForTimeout(400);
  expect(await page.locator('.gw-tree-child').count()).toBe(0);
});
