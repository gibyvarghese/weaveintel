// SPDX-License-Identifier: MIT
/**
 * geneWeave Builder — the record EDITOR pane (presentational), recreated from
 * "GeneWeave Builder.dc.html". A single-column form (max-width 640) grouped into
 * hairline-separated sections with emerald mono labels:
 *   BASICS (Shortcut + {{>key}} hint, Name) · THE BLOCK (What it's for, Block text as a
 *   dark monospace code editor with a MARKDOWN tab + char count) · DETAILS (Fill-in values
 *   as a validated JSON editor with Format, Labels as chips, Version) · AVAILABILITY (an
 *   animated Active toggle). A warm "danger zone" card holds Delete, demoted out of the
 *   action row, and a sticky bottom bar shows the dirty state + Cancel/Save.
 *
 * Dumb module: it takes the working draft + handlers from the container (builder-view.ts).
 */
import { h } from './dom.js';

export interface BuilderDraft {
  id: string; key: string; name: string; description: string; content: string;
  variables: string; tags: string[]; version: string; enabled: boolean; isNew?: boolean;
}
export interface EditorHandlers {
  onField: (field: keyof BuilderDraft, value: unknown) => void;
  onToggle: () => void;
  onAddTag: (label: string) => void;
  onRemoveTag: (index: number) => void;
  onFormatJson: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

function section(label: string, ...body: HTMLElement[]): HTMLElement {
  return h('div', { className: 'bld-section' }, h('div', { className: 'bld-section-label' }, label), ...body);
}
function field(label: string, control: HTMLElement, hint?: HTMLElement | null, headerRight?: HTMLElement | null): HTMLElement {
  return h('div', { className: 'bld-field' },
    h('div', { className: 'bld-field-head' }, h('label', { className: 'bld-label' }, label), headerRight ?? null),
    control,
    hint ?? null,
  );
}

function validateJson(str: string): string | null {
  try { JSON.parse(str || '[]'); return null; }
  catch (e) { return `Variables must be valid JSON — ${(e instanceof Error ? e.message : 'parse error').replace(/^JSON\.parse:\s*/, '').toLowerCase()}`; }
}

export function renderBuilderEditor(draft: BuilderDraft, dirty: boolean, h2: EditorHandlers): HTMLElement {
  const jsonError = validateJson(draft.variables);

  // BASICS
  const keyInput = h('input', { className: 'bld-input bld-mono', value: draft.key, onInput: (e: Event) => h2.onField('key', (e.target as HTMLInputElement).value) }) as HTMLInputElement;
  const nameInput = h('input', { className: 'bld-input', value: draft.name, onInput: (e: Event) => h2.onField('name', (e.target as HTMLInputElement).value) }) as HTMLInputElement;
  const basics = section('BASICS',
    field('Shortcut', keyInput, h('span', { className: 'bld-hint' }, 'Drop this block into any instruction by typing ', h('span', { className: 'bld-mono bld-keyhint' }, `{{>${draft.key || ''}}}`))),
    field('Name', nameInput),
  );

  // THE BLOCK — dark code editor
  const descTa = h('textarea', { className: 'bld-textarea', rows: 3, value: draft.description, onInput: (e: Event) => h2.onField('description', (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
  const contentTa = h('textarea', { className: 'bld-code-area', rows: 8, value: draft.content, onInput: (e: Event) => { h2.onField('content', (e.target as HTMLTextAreaElement).value); charCount.textContent = `${(e.target as HTMLTextAreaElement).value.length} chars`; } }) as HTMLTextAreaElement;
  const charCount = h('span', { className: 'bld-code-meta' }, `${draft.content.length} chars`) as HTMLElement;
  const codeEditor = h('div', { className: 'bld-code' },
    h('div', { className: 'bld-code-bar' }, h('span', { className: 'bld-code-meta' }, 'MARKDOWN'), charCount),
    contentTa,
  );
  const block = section('THE BLOCK',
    field('What it’s for', descTa, h('span', { className: 'bld-hint' }, 'A short, plain summary of what this block does.')),
    field('Block text', codeEditor),
  );

  // DETAILS
  const varsTa = h('textarea', { className: `bld-json${jsonError ? ' invalid' : ''}`, rows: 4, value: draft.variables, onInput: (e: Event) => h2.onField('variables', (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
  const formatBtn = h('button', { className: 'bld-mini-btn bld-mini-emerald', onClick: h2.onFormatJson }, 'Format');
  const tagsInput = h('input', { className: 'bld-tag-input', type: 'text', placeholder: 'Type to add…',
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) { h2.onAddTag(v); (e.target as HTMLInputElement).value = ''; } } } }) as HTMLInputElement;
  const chips = h('div', { className: 'bld-chips' },
    ...draft.tags.map((t, i) => h('span', { className: 'bld-chip' }, t, h('button', { className: 'bld-chip-x', onClick: () => h2.onRemoveTag(i) }, '×'))),
    tagsInput,
  );
  const versionInput = h('input', { className: 'bld-input bld-mono bld-version', value: draft.version, onInput: (e: Event) => h2.onField('version', (e.target as HTMLInputElement).value) }) as HTMLInputElement;
  const details = section('DETAILS',
    field('Fill-in values', varsTa,
      jsonError ? h('span', { className: 'bld-json-error' }, h('span', { className: 'bld-err-ic' }, '!'), jsonError) : h('span', { className: 'bld-hint' }, 'Values swapped in when the block is used · checked automatically.'),
      formatBtn),
    field('Labels', chips),
    field('Version', versionInput),
  );

  // AVAILABILITY — toggle
  const toggle = h('div', { className: `bld-toggle${draft.enabled ? ' on' : ''}`, onClick: h2.onToggle }, h('span', { className: 'bld-knob' }));
  const availability = section('AVAILABILITY',
    h('div', { className: 'bld-avail-card' },
      h('div', { className: 'bld-avail-text' },
        h('span', { className: 'bld-avail-title' }, 'Active'),
        h('span', { className: 'bld-avail-sub' }, 'When off, this block is skipped when instructions are put together.'),
      ),
      toggle,
    ),
  );

  // Danger zone
  const danger = h('div', { className: 'bld-danger' },
    h('div', { className: 'bld-danger-text' },
      h('span', { className: 'bld-danger-title' }, 'Delete building block'),
      h('span', { className: 'bld-danger-sub' }, 'This can’t be undone.'),
    ),
    h('button', { className: 'bld-danger-btn', onClick: h2.onDelete }, 'Delete'),
  );

  return h('div', { className: 'bld-editor-scroll gw-scroll' },
    h('div', { className: 'bld-form' }, basics, block, details, availability, danger),
  );
}

/** The sticky bottom action bar (dirty indicator + Cancel + Save). */
export function renderBuilderActionBar(dirty: boolean, jsonInvalid: boolean, h2: Pick<EditorHandlers, 'onSave' | 'onCancel'>): HTMLElement {
  return h('footer', { className: 'bld-actionbar' },
    h('span', { className: `bld-dirty${dirty ? ' on' : ''}` }, h('span', { className: 'bld-dirty-dot' }), dirty ? 'Unsaved changes' : 'All changes saved'),
    h('div', { className: 'bld-actions' },
      h('button', { className: 'bld-btn-ghost', onClick: h2.onCancel }, 'Cancel'),
      h('button', { className: `bld-btn-save${jsonInvalid ? ' disabled' : ''}`, onClick: jsonInvalid ? () => {} : h2.onSave }, dirty ? 'Save' : 'Saved'),
    ),
  );
}

export { validateJson };
