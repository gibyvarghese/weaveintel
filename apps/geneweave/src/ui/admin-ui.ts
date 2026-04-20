import { api } from './api.js';
import { h } from './dom.js';
import { state } from './state.js';
import { normalizeAdminPath } from './prompt-wizard-utils.js';
import { resetPromptWizard } from './prompt-wizard-state.js';

function getAdminSchema(tab: string): any {
  return (((typeof window !== 'undefined' && (window as any).ADMIN_SCHEMA) || {}) as any)[tab];
}

export async function adminDeleteRow(tab: string, row: any, render: () => void, loadAdmin: () => Promise<void>) {
  const schema = getAdminSchema(tab);
  if (!schema) return;
  const rowId = row?.id ?? row?.[schema.cols?.[0]];
  if (!rowId) return;
  if (!confirm('Delete this item?')) return;
  try {
    const base = normalizeAdminPath(schema.apiPath);
    await api.del(`${base}/${rowId}`);
    await loadAdmin();
    render();
  } catch (e) {
    console.error('Failed to delete row:', e);
  }
}

export function adminEditRow(
  tab: string,
  row: any,
  hydrateWizardFromPrompt: (promptRow: any) => void,
  render: () => void,
) {
  const schema = getAdminSchema(tab);
  if (!schema) return;

  if (tab === 'prompts') {
    hydrateWizardFromPrompt(row);
    state.adminEditing = row?.id ?? row?.[schema.cols?.[0]] ?? null;
    state.adminForm = { __promptWizard: true };
    render();
    return;
  }

  state.adminEditing = row?.id ?? row?.[schema.cols?.[0]] ?? null;
  const form = { ...row } as Record<string, unknown>;
  (schema.fields || []).forEach((field: any) => {
    if (field.save === 'csvArr' && form[field.key]) {
      try {
        form[field.key] = JSON.parse(String(form[field.key])).join(', ');
      } catch {}
    } else if ((field.textarea || field.save === 'json' || field.save === 'jsonStr') && form[field.key] != null && typeof form[field.key] !== 'string') {
      try {
        form[field.key] = JSON.stringify(form[field.key], null, 2);
      } catch {}
    }
  });
  state.adminForm = form;
  render();
}

export function adminNewRow(tab: string, render: () => void) {
  const schema = getAdminSchema(tab);
  if (!schema) return;

  if (tab === 'prompts') {
    resetPromptWizard(state, 'create');
    state.adminEditing = null;
    state.adminForm = { __promptWizard: true };
    render();
    return;
  }

  const form: Record<string, unknown> = {};
  (schema.fields || []).forEach((field: any) => {
    if (field.default != null) form[field.key] = field.default;
  });
  state.adminEditing = null;
  state.adminForm = form;
  render();
}

export function adminBackToList(tab: string | undefined, render: () => void) {
  if (!tab || tab === 'prompts') {
    state.promptWizard = null;
  }
  state.adminEditing = null;
  state.adminForm = {};
  render();
}

export function clearAdminEditorState() {
  state.adminEditing = null;
  state.adminForm = {};
}

export async function adminSaveRow(tab: string, render: () => void, loadAdmin: () => Promise<void>) {
  const schema = getAdminSchema(tab);
  if (!schema) return;
  const payload: Record<string, unknown> = {};
  const form = (state.adminForm || {}) as Record<string, unknown>;

  (schema.fields || []).forEach((field: any) => {
    let value = form[field.key];
    if (field.save === 'json') {
      try { value = value ? JSON.parse(String(value)) : null; } catch { value = null; }
    } else if (field.save === 'jsonStr') {
      try { value = value ? JSON.stringify(JSON.parse(String(value))) : null; } catch { value = null; }
    } else if (field.save === 'int') {
      value = value ? parseInt(String(value), 10) : (field.default ?? null);
    } else if (field.save === 'float') {
      value = value ? parseFloat(String(value)) : (field.default ?? null);
    } else if (field.save === 'csvArr') {
      value = value ? String(value).split(',').map((entry) => entry.trim()).filter(Boolean) : [];
    } else if (field.save === 'bool') {
      value = (value === undefined || value === null) ? (field.default ?? false) : (value !== false && value !== 'false');
    } else if (field.save === 'intBool') {
      value = value ? 1 : 0;
    } else {
      value = (value != null && value !== '') ? value : (field.default ?? null);
    }
    payload[field.key] = value;
  });

  try {
    const base = normalizeAdminPath(schema.apiPath);
    if (state.adminEditing) {
      await api.put(`${base}/${state.adminEditing}`, payload);
    } else {
      await api.post(base, payload);
    }
    state.adminEditing = null;
    state.adminForm = {};
    await loadAdmin();
    render();
  } catch (e) {
    console.error('Failed to save admin row:', e);
    alert('Save failed. Please check the values and try again.');
  }
}

export function renderAdminForm(
  tab: string,
  onSave: (tab: string) => void,
  onCancel: (tab?: string) => void,
): HTMLElement {
  const schema = getAdminSchema(tab);
  if (!schema) return h('div', null);
  const isEdit = !!state.adminEditing;
  const form = h('div', { className: 'chart-box', style: 'margin-bottom:16px;' },
    h('h3', null, `${isEdit ? 'Edit' : 'New'} ${schema.singular}`)
  );

  (schema.fields || []).forEach((field: any) => {
    const currentVal = (state.adminForm?.[field.key] ?? '') as any;
    const row = h('div', { style: 'margin-bottom:10px;' },
      h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, field.label)
    );

    if (field.type === 'checkbox') {
      const checkbox = h('input', {
        type: 'checkbox',
        checked: !!currentVal,
        onChange: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [field.key]: (e.target as HTMLInputElement).checked };
        },
      }) as HTMLInputElement;
      row.appendChild(checkbox);
    } else if (field.options && Array.isArray(field.options)) {
      const select = h('select', {
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        onChange: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [field.key]: (e.target as HTMLSelectElement).value };
        },
      }) as HTMLSelectElement;
      field.options.forEach((option: string) => {
        const el = h('option', { value: option }, option) as HTMLOptionElement;
        if (String(currentVal) === String(option)) el.selected = true;
        select.appendChild(el);
      });
      row.appendChild(select);
    } else if (field.textarea) {
      row.appendChild(h('textarea', {
        rows: String(field.rows || 3),
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
        value: String(currentVal ?? ''),
        onInput: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [field.key]: (e.target as HTMLTextAreaElement).value };
        },
      }));
    } else {
      row.appendChild(h('input', {
        type: field.type === 'number' ? 'number' : 'text',
        value: String(currentVal ?? ''),
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        onInput: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [field.key]: (e.target as HTMLInputElement).value };
        },
      }));
    }

    form.appendChild(row);
  });

  form.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:12px;' },
    h('button', { className: 'nav-btn active', onClick: () => onSave(tab) }, isEdit ? 'Update' : 'Create'),
    h('button', { className: 'nav-btn', onClick: () => onCancel(tab) }, 'Cancel')
  ));

  return form;
}

export function renderAdminBreadcrumbs(tab: string, schema: any, onBack: (tab?: string) => void): HTMLElement {
  const listLabel = schema ? `${schema.singular}s` : 'Records';
  const actionLabel = state.adminEditing ? 'Edit' : 'New';
  return h('nav', { className: 'admin-breadcrumbs', 'aria-label': 'Breadcrumb' },
    h('button', {
      className: 'admin-breadcrumb-back',
      title: `Back to ${listLabel}`,
      'data-testid': 'admin-breadcrumb-back',
      onClick: () => onBack(tab),
    }, '←'),
    h('ol', { className: 'admin-breadcrumb-list' },
      h('li', { className: 'admin-breadcrumb-item' },
        h('button', {
          className: 'admin-breadcrumb-link',
          'data-testid': 'admin-breadcrumb-list',
          onClick: () => onBack(tab),
        }, listLabel)
      ),
      h('li', { className: 'admin-breadcrumb-item admin-breadcrumb-item-current', 'aria-current': 'page' }, `${actionLabel} ${schema?.singular || 'Record'}`)
    )
  );
}

export function renderAdminView(options: {
  hydrateWizardFromPrompt: (promptRow: any) => void;
  renderPromptSetupWizard: () => HTMLElement;
  render: () => void;
  loadAdmin: () => Promise<void>;
}): HTMLElement {
  const tabs = Object.keys(((typeof window !== 'undefined' && (window as any).ADMIN_SCHEMA) || {}));
  const currentTab = tabs.includes(state.adminTab) ? state.adminTab : tabs[0];
  if (!tabs.includes(state.adminTab) && currentTab) {
    state.adminTab = currentTab;
  }
  const schema = getAdminSchema(currentTab);
  const rows = (state.adminData?.[currentTab] || []) as any[];
  const promptDetailOpen = currentTab === 'prompts' && !!((state.adminForm || {}) as any)['__promptWizard'];
  const showEditor = !schema?.readOnly && (promptDetailOpen || state.adminEditing !== null || Object.keys(state.adminForm || {}).length > 0);

  // Reset list controls when the active tab changes
  if (state.adminListCurrentTab !== currentTab) {
    state.adminListCurrentTab = currentTab;
    state.adminListSearch = '';
    state.adminListSortCol = null;
    state.adminListSortDir = 'asc';
    state.adminListGroupBy = '';
    state.adminListPage = 1;
    state.adminListGroupCollapsed = {};
  }

  const page = h('div', { className: 'dash-view' },
    h('h2', null, 'Administration'),
    schema ? h('div', { style: 'margin-top:-16px;margin-bottom:16px;color:var(--fg3);font-size:12px;' }, `${schema.singular}s`) : null
  );
  const right = h('div', { className: 'admin-main-panel' });

  if (showEditor) {
    right.appendChild(renderAdminBreadcrumbs(currentTab, schema, (tab) => adminBackToList(tab, options.render)));
    if (currentTab === 'prompts') {
      right.appendChild(options.renderPromptSetupWizard());
    } else {
      right.appendChild(h('div', { className: 'admin-detail-panel' }, renderAdminForm(
        currentTab,
        (tab) => { void adminSaveRow(tab, options.render, options.loadAdmin); },
        (tab) => adminBackToList(tab, options.render),
      )));
    }
    page.appendChild(right);
    return page;
  }

  const cols = (schema?.cols || []).slice(0, 6) as string[];
  const PAGE_SIZE = 25;
  const searchQuery = ((state.adminListSearch as string) || '').toLowerCase().trim();
  const sortCol: string | null = (state.adminListSortCol as string | null) || null;
  const sortDir: 'asc' | 'desc' = (state.adminListSortDir as 'asc' | 'desc') || 'asc';
  const groupBy: string = (state.adminListGroupBy as string) || '';
  const currentPage: number = (state.adminListPage as number) || 1;
  const groupCollapsed: Record<string, boolean> = (state.adminListGroupCollapsed as Record<string, boolean>) || {};

  // 1. Filter
  let filtered: any[] = rows.filter((row: any) => {
    if (!searchQuery) return true;
    return cols.some((col: string) => String(row?.[col] ?? '').toLowerCase().includes(searchQuery));
  });

  // 2. Sort
  if (sortCol) {
    filtered = [...filtered].sort((a: any, b: any) => {
      const av = String(a?.[sortCol] ?? '');
      const bv = String(b?.[sortCol] ?? '');
      const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  // 3. Paginate flat list
  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pagedRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  // 4. Group the current page's rows
  let groupedRows: Array<{ groupKey: string; rows: any[] }> | null = null;
  if (groupBy && cols.includes(groupBy)) {
    const groupMap = new Map<string, any[]>();
    pagedRows.forEach((row: any) => {
      const key = String(row?.[groupBy] ?? '(empty)');
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(row);
    });
    groupedRows = Array.from(groupMap.entries()).map(([groupKey, groupRows]) => ({ groupKey, rows: groupRows }));
  }

  const content = h('div', { className: 'admin-content-grid' });
  const listPanel = h('div', { className: 'table-wrap admin-list-panel' });

  // Panel header row: title + New button
  listPanel.appendChild(
    h('div', { className: 'admin-list-header' },
      h('h3', { style: 'margin:0;' }, schema ? `${schema.singular}s` : 'Records'),
      schema?.readOnly
        ? h('span', { style: 'font-size:12px;color:var(--fg3);' }, 'Read only')
        : h('button', { className: 'nav-btn active', onClick: () => adminNewRow(currentTab, options.render) }, '+ New')
    )
  );

  // Toolbar: search + group-by selector
  const searchInput = h('input', {
    type: 'text',
    className: 'admin-list-search',
    placeholder: `Search ${rows.length} record${rows.length !== 1 ? 's' : ''}…`,
    value: state.adminListSearch || '',
    onInput: (e: Event) => {
      state.adminListSearch = (e.target as HTMLInputElement).value;
      state.adminListPage = 1;
      options.render();
    },
  }) as HTMLInputElement;

  const groupBySelect = h('select', {
    className: 'admin-list-groupby',
    title: 'Group by column',
    onChange: (e: Event) => {
      state.adminListGroupBy = (e.target as HTMLSelectElement).value;
      state.adminListPage = 1;
      options.render();
    },
  }) as HTMLSelectElement;
  const noGroupOpt = h('option', { value: '' }, 'Group by…') as HTMLOptionElement;
  if (!groupBy) noGroupOpt.selected = true;
  groupBySelect.appendChild(noGroupOpt);
  cols.forEach((col: string) => {
    const opt = h('option', { value: col }, col.replace(/_/g, ' ')) as HTMLOptionElement;
    if (col === groupBy) opt.selected = true;
    groupBySelect.appendChild(opt);
  });

  listPanel.appendChild(
    h('div', { className: 'admin-list-toolbar' },
      h('div', { className: 'admin-list-search-wrap' },
        h('span', { className: 'admin-list-search-icon' }, '🔍'),
        searchInput
      ),
      groupBySelect
    )
  );

  if (!schema) {
    listPanel.appendChild(h('div', { style: 'padding:16px;color:var(--fg3);' }, 'No schema for selected tab.'));
  } else if (!rows.length) {
    listPanel.appendChild(h('div', { style: 'padding:20px;color:var(--fg3);text-align:center;' }, 'No records found. Create one with + New.'));
  } else if (!filtered.length) {
    listPanel.appendChild(h('div', { style: 'padding:20px;color:var(--fg3);text-align:center;' }, `No records match "${state.adminListSearch}".`));
  } else {
    // Sortable column header cells
    const headerCells = cols.map((col: string) => {
      const isActive = sortCol === col;
      const indicator = isActive ? (sortDir === 'asc' ? '↑' : '↓') : '↕';
      return h('th', {
        className: `sortable${isActive ? ' sort-active' : ''}`,
        onClick: () => {
          if (state.adminListSortCol === col) {
            state.adminListSortDir = state.adminListSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            state.adminListSortCol = col;
            state.adminListSortDir = 'asc';
          }
          state.adminListPage = 1;
          options.render();
        },
      },
        col.replace(/_/g, ' '),
        h('span', { className: 'sort-indicator' }, ` ${indicator}`)
      );
    });

    const tbody = h('tbody', null);

    if (groupedRows) {
      groupedRows.forEach(({ groupKey, rows: groupRowList }) => {
        const isCollapsed = groupCollapsed[groupKey] === true;
        tbody.appendChild(
          h('tr', {
            className: 'admin-group-header-row',
            onClick: () => {
              state.adminListGroupCollapsed = { ...groupCollapsed, [groupKey]: !isCollapsed };
              options.render();
            },
          },
            h('td', { colSpan: String(cols.length + 1) },
              isCollapsed ? '▶ ' : '▼ ',
              h('strong', null, groupKey),
              h('span', { className: 'admin-group-count' }, `${groupRowList.length} item${groupRowList.length !== 1 ? 's' : ''}`)
            )
          )
        );
        if (!isCollapsed) {
          groupRowList.forEach((row: any) => {
            tbody.appendChild(buildAdminRow(row, cols, currentTab, schema, options));
          });
        }
      });
    } else {
      pagedRows.forEach((row: any) => {
        tbody.appendChild(buildAdminRow(row, cols, currentTab, schema, options));
      });
    }

    listPanel.appendChild(
      h('table', { className: 'eval-table' },
        h('thead', null, h('tr', null, ...headerCells, h('th', null, 'Actions'))),
        tbody
      )
    );

    // Pagination footer
    const from = pageStart + 1;
    const to = Math.min(pageStart + PAGE_SIZE, totalItems);
    const countLabel = searchQuery
      ? `${from}–${to} of ${totalItems} filtered (${rows.length} total)`
      : `${from}–${to} of ${totalItems} record${totalItems !== 1 ? 's' : ''}`;

    // Page number buttons with ellipsis
    const pageButtons: HTMLElement[] = [];
    const WINDOW = 2;
    let lastRendered = 0;
    for (let p = 1; p <= totalPages; p++) {
      const inWindow = p === 1 || p === totalPages || (p >= safePage - WINDOW && p <= safePage + WINDOW);
      if (inWindow) {
        if (lastRendered && p - lastRendered > 1) {
          pageButtons.push(h('span', { className: 'admin-page-ellipsis' }, '…'));
        }
        pageButtons.push(
          h('button', {
            className: `admin-page-btn${p === safePage ? ' active' : ''}`,
            disabled: p === safePage,
            onClick: () => { state.adminListPage = p; options.render(); },
          }, String(p))
        );
        lastRendered = p;
      }
    }

    listPanel.appendChild(
      h('div', { className: 'admin-list-footer' },
        h('span', { className: 'admin-list-info' }, countLabel),
        h('div', { className: 'admin-list-pagination' },
          h('button', {
            className: 'admin-page-btn',
            disabled: safePage <= 1,
            onClick: () => { state.adminListPage = safePage - 1; options.render(); },
          }, '← Prev'),
          ...pageButtons,
          h('button', {
            className: 'admin-page-btn',
            disabled: safePage >= totalPages,
            onClick: () => { state.adminListPage = safePage + 1; options.render(); },
          }, 'Next →')
        )
      )
    );
  }

  content.appendChild(listPanel);
  right.appendChild(content);
  page.appendChild(right);
  return page;
}

function buildAdminRow(
  row: any,
  cols: string[],
  currentTab: string,
  schema: any,
  options: {
    hydrateWizardFromPrompt: (promptRow: any) => void;
    render: () => void;
    loadAdmin: () => Promise<void>;
  },
): HTMLElement {
  return h('tr', null,
    ...cols.map((col: string) => {
      const raw = row?.[col];
      const str = raw == null ? '—' : String(raw);
      const display = str.length > 60 ? str.slice(0, 57) + '…' : str;
      const attrs: Record<string, any> = {};
      if (str.length > 60) attrs['title'] = str;
      return h('td', attrs, display);
    }),
    h('td', null,
      h('div', { className: 'row-actions' },
        h('button', { className: 'row-btn row-btn-edit', onClick: () => adminEditRow(currentTab, row, options.hydrateWizardFromPrompt, options.render) }, 'Edit'),
        schema?.readOnly ? null : h('button', { className: 'row-btn row-btn-del', onClick: () => { void adminDeleteRow(currentTab, row, options.render, options.loadAdmin); } }, 'Delete')
      )
    )
  );
}