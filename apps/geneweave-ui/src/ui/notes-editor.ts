/**
 * notes-editor.ts — Tiptap editor island (WC6)
 *
 * Mounts a Tiptap editor into a provided container div. The module uses a
 * dynamic import of /notes-editor.bundle.js (a separately-bundled ESM file
 * containing @tiptap/core, @tiptap/starter-kit, and extensions). This keeps
 * the main ui-client.js bundle free of ProseMirror's large dependency tree.
 *
 * Features:
 *   • Blocks: paragraph, heading (1-3), bulletList, orderedList, taskList,
 *     blockquote, codeBlock, horizontalRule
 *   • Markdown input shortcuts (e.g. ## → heading, - → bullet)
 *   • Bubble toolbar: Bold / Italic / Strike / Code / Link
 *   • Slash command menu: floating "/ command" trigger for block insertion
 *   • Placeholder text when editor is empty
 *   • Auto-save: debounced 1.5s after last keystroke, calls onSave(doc_json)
 *
 * The bundle is loaded on first mount and cached in _bundle. Subsequent mounts
 * within the same page lifetime reuse the same bundle.
 */

// ── Bundle cache ──────────────────────────────────────────────────────────────

type TiptapExtension = { configure?: (opts: Record<string, unknown>) => unknown; [k: string]: unknown };
type TiptapBundle = {
  Editor: new (opts: Record<string, unknown>) => TiptapEditor;
  StarterKit: TiptapExtension;
  Placeholder: TiptapExtension;
  BubbleMenuExtension: TiptapExtension;
  FloatingMenuExtension: TiptapExtension;
  TaskList: TiptapExtension;
  TaskItem: TiptapExtension;
  Link: TiptapExtension;
  Underline: TiptapExtension;
};

type TiptapEditor = {
  destroy(): void;
  getJSON(): unknown;
  commands: Record<string, (...args: unknown[]) => unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain(): { focus(): { run(): void; [k: string]: any }; [k: string]: any };
  isDestroyed: boolean;
  on(event: string, handler: (props: Record<string, unknown>) => void): void;
};

let _bundle: TiptapBundle | null = null;

async function loadBundle(): Promise<TiptapBundle> {
  if (_bundle) return _bundle;
  // The bundle is served at /ui/notes-editor.bundle.js — matches the /ui/* static route.
  const mod = await import('/ui/notes-editor.bundle.js' as string);
  _bundle = mod as TiptapBundle;
  return _bundle;
}

// ── Bubble toolbar ────────────────────────────────────────────────────────────

function buildBubbleToolbar(editor: TiptapEditor): HTMLElement {
  const buttons: Array<{ label: string; action: () => void; isActive?: () => boolean }> = [
    { label: 'B', action: () => { editor.chain().focus()['toggleBold']?.().run(); }, isActive: () => false },
    { label: 'I', action: () => { editor.chain().focus()['toggleItalic']?.().run(); }, isActive: () => false },
    { label: 'S̶', action: () => { editor.chain().focus()['toggleStrike']?.().run(); }, isActive: () => false },
    { label: 'U', action: () => { editor.chain().focus()['toggleUnderline']?.().run(); }, isActive: () => false },
    { label: '<>', action: () => { editor.chain().focus()['toggleCode']?.().run(); }, isActive: () => false },
  ];

  const toolbar = document.createElement('div');
  toolbar.className = 'notes-bubble-toolbar';
  for (const btn of buttons) {
    const el = document.createElement('button');
    el.className = 'notes-bubble-btn';
    el.textContent = btn.label;
    el.onmousedown = (e) => { e.preventDefault(); btn.action(); };
    toolbar.appendChild(el);
  }
  return toolbar;
}

// ── Slash command menu ────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { label: '# Heading 1', icon: 'H1', action: (editor: TiptapEditor) => { editor.chain().focus()['setHeading']?.({ level: 1 }).run(); } },
  { label: '## Heading 2', icon: 'H2', action: (editor: TiptapEditor) => { editor.chain().focus()['setHeading']?.({ level: 2 }).run(); } },
  { label: '### Heading 3', icon: 'H3', action: (editor: TiptapEditor) => { editor.chain().focus()['setHeading']?.({ level: 3 }).run(); } },
  { label: '• Bullet list', icon: '•', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleBulletList']?.().run(); } },
  { label: '1. Ordered list', icon: '1.', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleOrderedList']?.().run(); } },
  { label: '☐ To-do list', icon: '☐', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleTaskList']?.().run(); } },
  { label: '" Blockquote', icon: '"', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleBlockquote']?.().run(); } },
  { label: '``` Code block', icon: '<>', action: (editor: TiptapEditor) => { editor.chain().focus()['toggleCodeBlock']?.().run(); } },
  { label: '── Divider', icon: '──', action: (editor: TiptapEditor) => { editor.chain().focus()['setHorizontalRule']?.().run(); } },
];

function buildSlashMenu(editor: TiptapEditor, query: string, onClose: () => void): HTMLElement {
  const lower = query.toLowerCase();
  const filtered = lower
    ? SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(lower))
    : SLASH_COMMANDS;

  const menu = document.createElement('div');
  menu.className = 'notes-slash-menu';

  for (const cmd of filtered.slice(0, 8)) {
    const item = document.createElement('div');
    item.className = 'notes-slash-item';
    item.innerHTML = `<span class="notes-slash-icon">${cmd.icon}</span><span>${cmd.label}</span>`;
    item.onmousedown = (e) => {
      e.preventDefault();
      cmd.action(editor);
      onClose();
    };
    menu.appendChild(item);
  }

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-slash-empty';
    empty.textContent = 'No commands found';
    menu.appendChild(empty);
  }

  return menu;
}

// ── Mount ─────────────────────────────────────────────────────────────────────

export interface EditorInstance {
  destroy(): void;
  getJSON(): unknown;
}

export async function mountNotesEditor(opts: {
  container: HTMLElement;
  initialDocJson: string;
  onSave: (docJson: string) => Promise<void>;
  placeholder?: string;
  readOnly?: boolean;
}): Promise<EditorInstance> {
  const { container, initialDocJson, onSave, placeholder = 'Start writing… type / for commands', readOnly = false } = opts;

  let doc: unknown;
  try { doc = JSON.parse(initialDocJson); } catch { doc = { type: 'doc', content: [] }; }

  const bundle = await loadBundle();

  // Containers
  const editorEl = document.createElement('div');
  editorEl.className = 'notes-editor-content';
  container.appendChild(editorEl);

  // Bubble menu container
  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'notes-bubble-wrapper';
  bubbleEl.style.display = 'none';
  container.appendChild(bubbleEl);

  // Slash menu state
  let slashMenu: HTMLElement | null = null;
  let slashQuery = '';

  function closeSlashMenu() {
    slashMenu?.remove();
    slashMenu = null;
    slashQuery = '';
  }

  // Auto-save debounce
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSave(editorInstance: TiptapEditor) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const json = JSON.stringify(editorInstance.getJSON());
      try { await onSave(json); } catch (e) { console.warn('[notes-editor] auto-save failed', e); }
    }, 1500);
  }

  const editor = new bundle.Editor({
    element: editorEl,
    editable: !readOnly,
    content: doc,
    extensions: [
      bundle.StarterKit,
      bundle.TaskList,
      bundle.TaskItem,
      bundle.Underline,
      bundle.Link,
      bundle.Placeholder?.configure?.({ placeholder }) ?? bundle.Placeholder,
    ],
    onUpdate: ({ editor: ed }: { editor: TiptapEditor }) => {
      scheduleSave(ed);
    },
    onSelectionUpdate: ({ editor: ed }: { editor: TiptapEditor }) => {
      // Show bubble toolbar when text is selected
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && !readOnly) {
        bubbleEl.style.display = 'block';
        bubbleEl.innerHTML = '';
        bubbleEl.appendChild(buildBubbleToolbar(ed));
      } else {
        bubbleEl.style.display = 'none';
      }
    },
  });

  // Slash command: detect "/" at start of line
  editorEl.addEventListener('keyup', (e) => {
    if (readOnly) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const text = selection.anchorNode?.textContent ?? '';
    const offset = selection.anchorOffset;
    const lineText = text.slice(0, offset);

    if (lineText.endsWith('/') || (slashMenu && lineText.includes('/'))) {
      const slashIdx = lineText.lastIndexOf('/');
      slashQuery = lineText.slice(slashIdx + 1);

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      if (slashMenu) {
        slashMenu.remove();
      }
      slashMenu = buildSlashMenu(editor, slashQuery, () => {
        closeSlashMenu();
        // Delete the /command text from the editor
        if (editor && !editor.isDestroyed) {
          editor.commands['deleteRange']?.({ from: (editor as any).state.selection.from - slashQuery.length - 1, to: (editor as any).state.selection.from });
        }
      });
      slashMenu.style.position = 'fixed';
      slashMenu.style.top = `${rect.bottom + window.scrollY + 4}px`;
      slashMenu.style.left = `${rect.left}px`;
      document.body.appendChild(slashMenu);
    } else if (e.key === 'Escape' || !lineText.includes('/')) {
      closeSlashMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (slashMenu && !slashMenu.contains(e.target as Node)) closeSlashMenu();
  }, { once: false });

  return {
    destroy() {
      if (saveTimer) clearTimeout(saveTimer);
      closeSlashMenu();
      editor.destroy();
    },
    getJSON() {
      return editor.getJSON();
    },
  };
}
