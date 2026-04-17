// Main geneWeave UI module - orchestrates all UI components
// Imports from modularized ui/ subdirectory

import {
  state,
  getCalendarFocusDate,
  setCalendarFocusDate,
  shiftCalendarMonth,
  toYMD,
  getTodayLabel,
} from './ui/state.js';
import { h } from './ui/dom.js';
import { STYLES } from './ui/styles.js';
import { 
  getUserAvatarUrl, 
  getAgentAvatarUrl,
  scrollMessages,
  toggleAudioRecording,
  queueFiles
} from './ui/utils.js';
import { 
  api, 
  loadChats, 
  selectChat, 
  createChat, 
  deleteChat,
  loadModels,
  loadTools,
  loadUserPreferences,
  loadAdmin,
  loadDashboard,
  loadConnectors,
  loadCredentials,
  loadSSOProviders,
  loadOAuthAccounts,
  loadPasswordProviders,
  loadChatSettings,
  saveChatSettings
} from './ui/api.js';
import { ADMIN_TAB_GROUPS, ADMIN_TABS } from './admin-schema.js';
import { 
  doLogout,
  renderAuth
} from './ui/auth.js';
import type { Message, Chat } from './ui/types.js';

// ============================================================================
// HTML GENERATION (Server-side)
// ============================================================================

export function getHTML(): string {
  // Embed admin schema and styles as inline content
  const adminGroupsJson = JSON.stringify(ADMIN_TAB_GROUPS);
  const adminSchemaJson = JSON.stringify(ADMIN_TABS);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>geneWeave</title>
  <style>${STYLES}</style>
</head>
<body>
<div id="root"></div>
<script>
// Embed admin schema as global variables so client code can access them
window.ADMIN_GROUPS = ${adminGroupsJson};
window.ADMIN_SCHEMA = ${adminSchemaJson};
</script>
<script type="module">
  import { initialize } from '/ui.js';
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
</script>
</body>
</html>`;
}

// ============================================================================
// RENDERING FUNCTIONS
// ============================================================================

async function sendMessage(text: string) {
  if (!text.trim()) return;
  if (!state.currentChatId) {
    await createChat();
  }
  if (!state.currentChatId) return;
  
  state.messages.push({
    role: 'user',
    content: text,
  });
  state.streaming = true;
  render();
  
  try {
    const r = await api.post(`/chats/${state.currentChatId}/messages`, {
      content: text,
      attachments: state.pendingAttachments,
    });
    
    if (r && typeof r === 'object' && 'ok' in r && (r as Response).ok) {
      const data = await (r as Response).json() as any;
      if (typeof data?.assistantContent === 'string' && data.assistantContent.length) {
        state.messages.push({
          role: 'assistant',
          content: data.assistantContent,
          metadata: JSON.stringify({
            eval: data?.eval,
            guardrail: data?.guardrail,
            cognitive: data?.cognitive,
            steps: data?.steps,
          }),
          tokens_used: data?.usage?.totalTokens ?? 0,
          cost: data?.cost ?? 0,
          latency_ms: data?.latencyMs ?? 0,
        } as any);
      } else if (Array.isArray(data?.messages)) {
        state.messages = data.messages;
      }
      state.pendingAttachments = [];
    } else {
      console.error('Message send failed:', (r as Response)?.status, (r as Response)?.statusText);
    }
  } catch (e) {
    console.error('Failed to send message:', e);
  }
  
  state.streaming = false;
  render();
  scrollMessages();
}

function renderMessages() {
  const container = document.querySelector('.messages');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (!state.messages.length) {
    container.appendChild(h('div', {className:'empty-chat'},
      h('div',null,'Start a conversation with geneWeave'),
      h('div',null,'Choose a model above and type your message')
    ));
    return;
  }
  
  state.messages.forEach((m: Message) => {
    const isUser = m.role === 'user';
    const bubble = h('div', {className:'bubble'}, m.content || (state.streaming ? '' : '...'));
    
    const avatarEl = h('div', {className:'avatar'});
    const img = document.createElement('img');
    img.src = isUser ? getUserAvatarUrl() : getAgentAvatarUrl();
    img.alt = isUser ? 'User' : 'Agent';
    avatarEl.appendChild(img);
    
    const msgEl = h('div', {className:'msg ' + (isUser ? 'user' : 'assistant')},
      avatarEl,
      h('div', {className:'msg-body'}, bubble)
    );
    
    container.appendChild(msgEl);
  });
}

function renderChatView() {
  const view = h('div', {className:'chat-view'});
  
  const ta = h('textarea', {placeholder:'Type a message...', rows:'1'}) as HTMLTextAreaElement;
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(ta.value);
      ta.value = '';
      ta.style.height = 'auto';
    }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  });
  
  const msgContainer = h('div', {className:'messages'});
  view.appendChild(msgContainer);
  
  const fileInput = h('input', {type:'file', multiple:true, style:'display:none'}) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    await queueFiles(files as File[]);
    fileInput.value = '';
  });
  
  view.appendChild(h('div', {className:'input-bar'},
    fileInput,
    h('div', {className:'input-tools'},
      h('button', {className:'tool-btn', title:'Attach files', onClick:()=>fileInput.click()},'📎'),
      h('button', {className:'tool-btn'+(state.audioRecording?' active':''), title:state.audioRecording?'Stop recording':'Record audio', onClick:()=>toggleAudioRecording()}, state.audioRecording?'⏹':'🎤')
    ),
    h('div', {className:'composer-wrap'}, ta),
    h('button', {className:'send-btn', onClick:()=>{sendMessage(ta.value);ta.value='';ta.style.height='auto';}, disabled:state.streaming?'true':null},'Send')
  ));
  
  setTimeout(() => {
    renderMessages();
    scrollMessages();
  }, 0);
  
  return view;
}

function renderWorkspaceNav() {
  const nav = h('aside', {className:'workspace-nav'});
  nav.appendChild(h('div', {className:'brand'}, '✦', h('span', {className:'word'}, 'geneWeave')));
  
  const menu = h('div', {className:'workspace-menu'});
  menu.appendChild(h('button', {className:state.view==='chat'?'active':'', onClick:()=>{state.view='chat'; render();}}, '⌂', h('span',null,'Home')));
  menu.appendChild(h('button', {className:state.view==='connectors'?'active':'', onClick:()=>{void openConnectorsView();}}, '⚡', h('span',null,'Connectors')));
  menu.appendChild(h('button', {className:state.view==='admin'?'active':'', onClick:()=>{state.view='admin'; void loadAdmin();}}, '⚙', h('span',null,'Admin')));
  menu.appendChild(h('button', {className:state.view==='dashboard'?'active':'', onClick:()=>{state.view='dashboard'; void loadDashboard();}}, '▦', h('span',null,'Dashboard')));
  nav.appendChild(menu);
  
  const spacer = h('div', {className:'workspace-spacer'});
  nav.appendChild(spacer);
  
  const footer = h('div', {className:'workspace-menu'});
  footer.appendChild(h('button', {onClick:async()=>{await doLogout(); render();}}, '⎋', h('span',null,'Log Out')));
  nav.appendChild(footer);
  
  return nav;
}

function renderWorkspaceTopCard() {
  const userName = (state.user?.name || 'User') as string;
  const userEmail = (state.user?.email || '') as string;
  const openProfile = (e: Event) => {
    e.stopPropagation();
    state.showNotifications = false;
    state.showProfile = !state.showProfile;
    render();
  };

  const profileAnchor = h('div', { className: 'dropdown-anchor' });
  const profileBtn = h(
    'button',
    { className: 'profile-avatar', title: 'Profile and preferences', onClick: openProfile },
    h('img', {
      src: getUserAvatarUrl(),
      alt: userName,
      style: 'width:100%;height:100%;border-radius:50%;object-fit:cover;',
    })
  );
  profileAnchor.appendChild(profileBtn);

  if (state.showProfile) {
    const dd = renderProfileDropdown();
    document.body.appendChild(dd);
    requestAnimationFrame(() => {
      const r = profileBtn.getBoundingClientRect();
      (dd as HTMLElement).style.top = `${r.bottom + 8}px`;
      (dd as HTMLElement).style.right = `${window.innerWidth - r.right}px`;
    });
  }

  return h(
    'div',
    { className: 'workspace-top-card' },
    h(
      'div',
      { className: 'user-chip' },
      h('img', { src: getUserAvatarUrl(), alt: userName }),
      h(
        'div',
        null,
        h('div', { className: 'name' }, userName),
        h('div', { className: 'role' }, userEmail || 'Signed in')
      )
    ),
    h('div', { className: 'today-badge' }, '◷ ', getTodayLabel()),
    h('div', { className: 'semantic-search' },
      h('input', {
        type: 'text',
        value: state.chatSearchQuery || '',
        placeholder: 'Search chats...',
        onInput: (e: Event) => {
          state.chatSearchQuery = (e.target as HTMLInputElement).value || '';
          render();
        },
      }),
      state.chatSearchQuery
        ? h(
            'div',
            { className: 'search-dd' },
            ...state.chats
              .filter((c: Chat) =>
                (c.title || '').toLowerCase().includes(String(state.chatSearchQuery).toLowerCase())
              )
              .slice(0, 8)
              .map((c: Chat) =>
                h(
                  'div',
                  {
                    className: 'search-item',
                    onClick: () => {
                      state.chatSearchQuery = '';
                      void selectChat(c.id);
                    },
                  },
                  h('div', { className: 'ttl' }, c.title || 'New Chat'),
                  h(
                    'div',
                    { className: 'sub' },
                    new Date(c.updated_at || c.created_at || Date.now()).toLocaleString()
                  )
                )
              )
          )
        : null
    ),
    h('div', { className: 'top-actions' },
      h('button', { className: 'nav-btn', onClick: () => createChat() }, '+ New Chat'),
      profileAnchor
    )
  );
}

function renderCalendarWidget() {
  const focus = getCalendarFocusDate();
  const year = focus.getFullYear();
  const month = focus.getMonth();
  const selectedYMD = toYMD(focus);

  const counts: Record<number, number> = {};
  state.chats.forEach((c: Chat) => {
    const d = new Date(c.updated_at || c.created_at || Date.now());
    if (d.getFullYear() === year && d.getMonth() === month) {
      counts[d.getDate()] = (counts[d.getDate()] || 0) + 1;
    }
  });

  const focusDays: Date[] = [];
  for (let i = -1; i <= 3; i++) {
    focusDays.push(new Date(year, month, focus.getDate() + i));
  }

  const monthFirst = new Date(year, month, 1);
  const monthLast = new Date(year, month + 1, 0);
  const monthCells: HTMLElement[] = [];
  for (let i = 0; i < monthFirst.getDay(); i++) monthCells.push(h('div', { className: 'md empty' }, ''));
  for (let day = 1; day <= monthLast.getDate(); day++) {
    const d = new Date(year, month, day);
    const dYMD = toYMD(d);
    monthCells.push(
      h(
        'div',
        {
          className: `md${counts[day] ? ' has' : ''}${dYMD === selectedYMD ? ' active' : ''}`,
          onClick: () => {
            setCalendarFocusDate(d);
            render();
          },
        },
        String(day)
      )
    );
  }

  const meetingsBody = [
    h('div', { className: 'meet-card peach' },
      h('div', { className: 'meet-title' }, 'Agent Review and Approval'),
      h(
        'div',
        { className: 'meet-time' },
        `${focus.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit' })} • 08:00 - 08:45 (UTC)`
      )
    ),
    h('div', { className: 'meet-card blue' },
      h('div', { className: 'meet-title' }, 'Chat Follow-up Actions'),
      h(
        'div',
        { className: 'meet-time' },
        `${focus.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit' })} • 09:00 - 09:45 (UTC)`
      )
    ),
  ];

  const eventsBody = state.chats.slice(0, 2).map((c: Chat) =>
    h('div', { className: 'meet-card blue' },
      h('div', { className: 'meet-title' }, c.title || 'Chat Event'),
      h('div', { className: 'meet-time' }, `${new Date(c.updated_at || c.created_at || Date.now()).toLocaleDateString()} • Model activity`)
    )
  );

  const holidayBody = [
    h('div', { className: 'meet-card peach' },
      h('div', { className: 'meet-title' }, 'No scheduled holidays'),
      h('div', { className: 'meet-time' }, 'Use this tab for OOO and downtime events')
    ),
  ];

  const tabContent = state.calendarTab === 'events'
    ? eventsBody
    : state.calendarTab === 'holiday'
      ? holidayBody
      : meetingsBody;

  return h('div', { className: 'side-card schedule-card' },
    h('div', { className: 'schedule-head' },
      h('div', { className: 'ttl' }, '◷ Schedule'),
      h('div', { className: 'month-nav' },
        h('button', { className: 'icon-btn-sm', title: 'Previous month', onClick: () => { shiftCalendarMonth(-1); render(); } }, '‹'),
        h('div', { className: 'month-pill' }, focus.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })),
        h('button', { className: 'icon-btn-sm', title: 'Next month', onClick: () => { shiftCalendarMonth(1); render(); } }, '›')
      ),
      h('button', { className: 'see-all', title: 'Toggle full month', onClick: () => { state.calendarShowAll = !state.calendarShowAll; render(); } }, state.calendarShowAll ? 'Hide' : 'See all')
    ),
    !state.calendarShowAll
      ? h(
          'div',
          { className: 'day-strip' },
          ...focusDays.map((d) =>
            h(
              'div',
              {
                className: `day-chip${toYMD(d) === selectedYMD ? ' active' : ''}`,
                title: `${counts[d.getDate()] || 0} actions`,
                onClick: () => {
                  setCalendarFocusDate(d);
                  render();
                },
              },
              h('div', { className: 'dw' }, d.toLocaleDateString(undefined, { weekday: 'short' })),
              h('div', { className: 'dn' }, String(d.getDate()).padStart(2, '0'))
            )
          )
        )
      : h(
          'div',
          { className: 'month-grid' },
          ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => h('div', { className: 'mh' }, x)),
          ...monthCells
        ),
    h('div', { className: 'schedule-search' },
      h('div', { className: 'search-row' }, '🔍', ' Search...', h('span', { style: 'margin-left:auto' }, '☰'))
    ),
    h('div', { className: 'schedule-tabs' },
      h('div', { className: `schedule-tab${state.calendarTab === 'meetings' ? ' active' : ''}`, onClick: () => { state.calendarTab = 'meetings'; render(); } }, 'Meetings'),
      h('div', { className: `schedule-tab${state.calendarTab === 'events' ? ' active' : ''}`, onClick: () => { state.calendarTab = 'events'; render(); } }, 'Events'),
      h('div', { className: `schedule-tab${state.calendarTab === 'holiday' ? ' active' : ''}`, onClick: () => { state.calendarTab = 'holiday'; render(); } }, 'Holiday')
    ),
    h('div', { className: 'schedule-meetings' }, ...tabContent)
  );
}

function renderActionsWidget() {
  const actions = state.chats.slice(0, 8).map((c: Chat) => ({
    id: c.id,
    title: c.title || 'New Chat',
    sub: `Updated ${new Date(c.updated_at || c.created_at || Date.now()).toLocaleString()}`,
  }));

  return h('div', { className: 'side-card actions-card' },
    h('h3', null, 'My Actions'),
    h('div', { className: 'action-list' },
      ...actions.map((a: { id: string; title: string; sub: string }) =>
        h('div', { className: `action-item selectable${state.currentChatId === a.id ? ' active' : ''}`, onClick:()=>{ void selectChat(a.id); } },
          h('div', { className: 'at' }, a.title),
          h('div', { className: 'as' }, a.sub)
        )
      ),
      !actions.length ? h('div', { className: 'action-item' }, h('div', { className: 'as' }, 'No actions yet')) : null
    )
  );
}

function renderProfileDropdown() {
  const u = state.user || {};
  const avatar = h('img', {
    src: getUserAvatarUrl(),
    alt: u.name || 'User',
    style: 'width:48px;height:48px;border-radius:50%;object-fit:cover;margin-bottom:10px;',
  });

  return h('div', { className: 'dropdown profile-dd', onClick: (e: Event) => e.stopPropagation() },
    avatar,
    h('div', { className: 'pf-name' }, u.name || 'User'),
    h('div', { className: 'pf-email' }, u.email || ''),
    h('div', { className: 'pf-divider' }),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'preferences'; state.showProfile = false; render(); } }, '⚙ Preferences'),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'dashboard'; state.showProfile = false; render(); void loadDashboard(); } }, '📊 Dashboard'),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'admin'; state.showProfile = false; render(); void loadAdmin(); } }, '⚙ Admin'),
    h('div', { className: 'pf-divider' }),
    h('button', { className: 'pf-btn danger', onClick: async () => { state.showProfile = false; await doLogout(); render(); } }, '🚪 Sign Out')
  );
}

function renderDashboardView() {
  const d = state.dashboard;
  const view = h('div', { className: 'dash-view' }, h('h2', null, 'Dashboard'));
  if (!d || !d.overview) {
    view.appendChild(h('div', { className: 'empty-chat' }, 'Loading dashboard...'));
    return view;
  }

  const s = d.overview.summary || {};
  view.appendChild(
    h('div', { className: 'cards' },
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Total Tokens'), h('div', { className: 'value tokens' }, String((s.total_tokens || 0).toLocaleString()))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Total Cost'), h('div', { className: 'value cost' }, '$' + Number(s.total_cost || 0).toFixed(4))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Avg Latency'), h('div', { className: 'value latency' }, String(s.avg_latency_ms || 0) + 'ms')),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Messages'), h('div', { className: 'value' }, String(s.total_messages || 0))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Chats'), h('div', { className: 'value' }, String(s.total_chats || 0)))
    )
  );

  const evals = d.evals?.evals || [];
  if (evals.length) {
    view.appendChild(
      h('div', { className: 'table-wrap' },
        h('h3', null, 'Evaluation Results'),
        h('table', { className: 'eval-table' },
          h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Score'), h('th', null, 'Passed'), h('th', null, 'Date'))),
          h('tbody', null,
            ...evals.slice(0, 20).map((ev: any) =>
              h('tr', null,
                h('td', null, ev.eval_name || 'Eval'),
                h('td', null, ((Number(ev.score || 0) * 100).toFixed(1)) + '%'),
                h('td', null, `${ev.passed || 0}/${ev.total || 0}`),
                h('td', null, String(ev.created_at || '').slice(0, 16))
              )
            )
          )
        )
      )
    );
  }

  return view;
}

function normalizeAdminPath(path: string): string {
  let p = String(path || '').replace(/^\/+/, '');
  if (p.startsWith('api/')) p = p.slice(4);
  return '/' + p;
}

async function adminDeleteRow(tab: string, row: any) {
  const schema = (ADMIN_TABS as any)[tab];
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

function adminEditRow(tab: string, row: any) {
  const schema = (ADMIN_TABS as any)[tab];
  if (!schema) return;

  state.adminEditing = row?.id ?? row?.[schema.cols?.[0]] ?? null;
  const f = { ...row } as Record<string, unknown>;
  (schema.fields || []).forEach((fd: any) => {
    if (fd.save === 'csvArr' && f[fd.key]) {
      try {
        f[fd.key] = JSON.parse(String(f[fd.key])).join(', ');
      } catch {}
    } else if ((fd.textarea || fd.save === 'json' || fd.save === 'jsonStr') && f[fd.key] != null && typeof f[fd.key] !== 'string') {
      try {
        f[fd.key] = JSON.stringify(f[fd.key], null, 2);
      } catch {}
    }
  });
  state.adminForm = f;
  render();
}

function adminNewRow(tab: string) {
  const schema = (ADMIN_TABS as any)[tab];
  if (!schema) return;
  const f: Record<string, unknown> = {};
  (schema.fields || []).forEach((fd: any) => {
    if (fd.default != null) f[fd.key] = fd.default;
  });
  state.adminEditing = null;
  state.adminForm = f;
  render();
}

function adminCancelEdit() {
  state.adminEditing = null;
  state.adminForm = {};
  render();
}

async function adminSaveRow(tab: string) {
  const schema = (ADMIN_TABS as any)[tab];
  if (!schema) return;
  const payload: Record<string, unknown> = {};
  const f = (state.adminForm || {}) as Record<string, unknown>;

  (schema.fields || []).forEach((fd: any) => {
    let val = f[fd.key];
    if (fd.save === 'json') {
      try { val = val ? JSON.parse(String(val)) : null; } catch { val = null; }
    } else if (fd.save === 'jsonStr') {
      try { val = val ? JSON.stringify(JSON.parse(String(val))) : null; } catch { val = null; }
    } else if (fd.save === 'int') {
      val = val ? parseInt(String(val), 10) : (fd.default ?? null);
    } else if (fd.save === 'float') {
      val = val ? parseFloat(String(val)) : (fd.default ?? null);
    } else if (fd.save === 'csvArr') {
      val = val ? String(val).split(',').map((s) => s.trim()).filter(Boolean) : [];
    } else if (fd.save === 'bool') {
      val = (val === undefined || val === null) ? (fd.default ?? false) : (val !== false && val !== 'false');
    } else if (fd.save === 'intBool') {
      val = val ? 1 : 0;
    } else {
      val = (val != null && val !== '') ? val : (fd.default ?? null);
    }
    payload[fd.key] = val;
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

function renderAdminForm(tab: string) {
  const schema = (ADMIN_TABS as any)[tab];
  if (!schema) return h('div', null);
  const isEdit = !!state.adminEditing;
  const form = h('div', { className: 'chart-box', style: 'margin-bottom:16px;' },
    h('h3', null, `${isEdit ? 'Edit' : 'New'} ${schema.singular}`)
  );

  (schema.fields || []).forEach((fd: any) => {
    const currentVal = (state.adminForm?.[fd.key] ?? '') as any;
    const row = h('div', { style: 'margin-bottom:10px;' },
      h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, fd.label)
    );

    if (fd.type === 'checkbox') {
      const cb = h('input', {
        type: 'checkbox',
        checked: !!currentVal,
        onChange: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [fd.key]: (e.target as HTMLInputElement).checked };
        },
      }) as HTMLInputElement;
      row.appendChild(cb);
    } else if (fd.options && Array.isArray(fd.options)) {
      const sel = h('select', {
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        onChange: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [fd.key]: (e.target as HTMLSelectElement).value };
        },
      }) as HTMLSelectElement;
      fd.options.forEach((opt: string) => {
        const o = h('option', { value: opt }, opt) as HTMLOptionElement;
        if (String(currentVal) === String(opt)) o.selected = true;
        sel.appendChild(o);
      });
      row.appendChild(sel);
    } else if (fd.textarea) {
      row.appendChild(h('textarea', {
        rows: String(fd.rows || 3),
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
        value: String(currentVal ?? ''),
        onInput: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [fd.key]: (e.target as HTMLTextAreaElement).value };
        },
      }));
    } else {
      row.appendChild(h('input', {
        type: fd.type === 'number' ? 'number' : 'text',
        value: String(currentVal ?? ''),
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        onInput: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [fd.key]: (e.target as HTMLInputElement).value };
        },
      }));
    }

    form.appendChild(row);
  });

  form.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:12px;' },
    h('button', { className: 'nav-btn active', onClick: () => { void adminSaveRow(tab); } }, isEdit ? 'Update' : 'Create'),
    h('button', { className: 'nav-btn', onClick: () => adminCancelEdit() }, 'Cancel')
  ));

  return form;
}

function renderAdminView() {
  const tabs = Object.keys(ADMIN_TABS);
  const currentTab = tabs.includes(state.adminTab) ? state.adminTab : tabs[0];
  const schema = (ADMIN_TABS as any)[currentTab];
  const rows = (state.adminData?.[currentTab] || []) as any[];

  const page = h('div', { className: 'dash-view' }, h('h2', null, 'Administration'));
  const layout = h('div', { style: 'display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px;align-items:start;' });

  const left = h('div', { className: 'chart-box', style: 'max-height:74vh;overflow:auto;' });
  ADMIN_TAB_GROUPS.forEach((group: any) => {
    left.appendChild(h('div', { style: 'font-size:11px;color:var(--fg3);text-transform:uppercase;letter-spacing:.4px;margin:8px 0 6px;font-weight:700;' }, `${group.icon} ${group.label}`));
    group.tabs.forEach((tab: any) => {
      if (!tabs.includes(tab.key)) return;
      left.appendChild(h('button', {
        className: state.adminTab === tab.key ? 'nav-btn active' : 'nav-btn',
        style: 'display:block;width:100%;text-align:left;margin-bottom:6px;',
        onClick: () => { state.adminTab = tab.key; render(); },
      }, tab.label));
    });
  });

  const right = h('div', { className: 'table-wrap' });
  right.appendChild(h('h3', null, schema ? `${schema.singular}s` : 'Records'));
  right.appendChild(h('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:12px 20px 8px;color:var(--fg2);font-size:12px;' },
    h('span', null, `${rows.length} item${rows.length !== 1 ? 's' : ''}`),
    schema?.readOnly ? h('span', null, 'Read only') : h('button', { className: 'nav-btn active', onClick: () => adminNewRow(currentTab) }, '+ New')
  ));
  if (!schema?.readOnly && (state.adminEditing !== null || Object.keys(state.adminForm || {}).length > 0)) {
    right.appendChild(renderAdminForm(currentTab));
  }
  if (!schema) {
    right.appendChild(h('div', { style: 'padding:16px;color:var(--fg3);' }, 'No schema for selected tab.'));
  } else if (!rows.length) {
    right.appendChild(h('div', { style: 'padding:16px;color:var(--fg3);' }, 'No records found.'));
  } else {
    right.appendChild(
      h('table', { className: 'eval-table' },
        h('thead', null,
          h('tr', null,
            ...schema.cols.slice(0, 6).map((c: string) => h('th', null, c.replace(/_/g, ' '))),
            h('th', null, 'Actions')
          )
        ),
        h('tbody', null,
          ...rows.slice(0, 80).map((row: any) =>
            h('tr', null,
              ...schema.cols.slice(0, 6).map((c: string) => h('td', null, String(row?.[c] ?? '-'))),
              h('td', null,
                h('div', { className: 'row-actions' },
                  h('button', { className: 'row-btn row-btn-edit', onClick: () => adminEditRow(currentTab, row) }, 'Edit'),
                  h('button', { className: 'row-btn row-btn-del', onClick: () => { void adminDeleteRow(currentTab, row); } }, 'Delete')
                )
              )
            )
          )
        )
      )
    );
  }

  layout.appendChild(left);
  layout.appendChild(right);
  page.appendChild(layout);
  return page;
}

async function openConnectorsView() {
  await loadConnectors();
  await Promise.all([loadCredentials(), loadSSOProviders(), loadOAuthAccounts(), loadPasswordProviders()]);
  render();
}

const CONNECTOR_DEFS = [
  { id: 'jira', label: 'Jira', category: 'enterprise', desc: 'Project tracking and issue management', color: '#0052CC' },
  { id: 'servicenow', label: 'ServiceNow', category: 'enterprise', desc: 'IT service management and workflows', color: '#62D84E', needsDomain: true },
  { id: 'canva', label: 'Canva', category: 'enterprise', desc: 'Design assets and creative workflows', color: '#00C4CC' },
  { id: 'facebook', label: 'Facebook', category: 'social', desc: 'Pages, posts, and audience engagement', color: '#1877F2' },
  { id: 'instagram', label: 'Instagram', category: 'social', desc: 'Business content and media publishing', color: '#E4405F' },
];

function getConnectorStatus(def: any) {
  const list = def.category === 'social' ? (state.connectors?.social || []) : (state.connectors?.enterprise || []);
  const key = def.category === 'social' ? 'platform' : 'connector_type';
  return list.find((c: any) => c?.[key] === def.id || String(c?.name || '').toLowerCase() === def.id);
}

async function startOAuthFlow(def: any, connectorId: string) {
  const qs = new URLSearchParams({ connector_id: connectorId || '' });
  if (def.needsDomain) {
    const domain = window.prompt('Enter ServiceNow domain (without .service-now.com):', '');
    if (!domain) return;
    qs.set('domain', domain);
  }

  const r = await api.get(`/connectors/${def.id}/authorize?${qs.toString()}`);
  const data = await r.json();
  if (!r.ok || !data.url) {
    alert(data?.error || 'Could not get authorization URL');
    return;
  }

  const popup = window.open(data.url, `oauth-${def.id}`, 'width=600,height=700,scrollbars=yes');
  if (!popup) {
    alert('Popup blocked. Please allow popups for this site.');
    return;
  }

  function onMsg(e: MessageEvent) {
    if (e.origin !== window.location.origin) return;
    if (!e.data || (e.data.type !== 'oauth-success' && e.data.type !== 'oauth-error')) return;
    window.removeEventListener('message', onMsg);
    if (e.data.type === 'oauth-error') {
      alert(`OAuth error: ${e.data.error || 'Unknown error'}`);
    }
    void openConnectorsView();
  }

  window.addEventListener('message', onMsg);
}

async function connectorConnect(def: any) {
  let existing = getConnectorStatus(def);
  let connectorId = existing?.id as string | undefined;
  if (!connectorId) {
    const table = def.category === 'social' ? 'social-accounts' : 'enterprise-connectors';
    const body = def.category === 'social'
      ? { name: def.label, platform: def.id, description: def.desc }
      : { name: def.label, connector_type: def.id, description: def.desc, auth_type: 'oauth2' };
    const r = await api.post(`/admin/${table}`, body);
    const data = await r.json();
    connectorId = data?.['social-account']?.id || data?.['enterprise-connector']?.id;
    existing = getConnectorStatus(def);
  }
  if (!connectorId && existing?.id) connectorId = existing.id;
  if (connectorId) {
    await startOAuthFlow(def, connectorId);
  }
}

async function connectorDisconnect(def: any) {
  const existing = getConnectorStatus(def);
  if (!existing?.id) return;
  await api.post(`/connectors/${existing.id}/disconnect`, { table: def.category === 'social' ? 'social' : 'enterprise' });
  await openConnectorsView();
}

async function connectorTest(def: any) {
  const existing = getConnectorStatus(def);
  if (!existing?.id) return;
  const r = await api.post(`/connectors/${existing.id}/test`, { table: def.category === 'social' ? 'social' : 'enterprise' });
  const data = await r.json();
  alert(data?.ok ? `Connection verified: ${data.message || 'OK'}` : `Connection test failed: ${data?.message || data?.error || 'Unknown error'}`);
}

function startAddCredential() {
  state.credentialEditing = null;
  state.credentialForm = { siteName: '', siteUrlPattern: '', authMethod: 'form_fill', username: '', password: '' };
  render();
}

function startEditCredential(cred: any) {
  state.credentialEditing = cred.id;
  state.credentialForm = {
    siteName: cred.siteName,
    siteUrlPattern: cred.siteUrlPattern,
    authMethod: cred.authMethod,
    username: '',
    password: '',
    headerValue: '',
    cookiesJson: '[]',
  };
  render();
}

async function saveCredential() {
  const f = state.credentialForm || {};
  if (!f.siteName || !f.siteUrlPattern || !f.authMethod) {
    alert('Site Name, URL Pattern, and Auth Method are required.');
    return;
  }

  const config: Record<string, unknown> = { method: f.authMethod };
  if (f.authMethod === 'form_fill') {
    config['username'] = f.username || '';
    config['password'] = f.password || '';
  } else if (f.authMethod === 'header') {
    config['headerValue'] = f.headerValue || '';
  } else if (f.authMethod === 'cookie') {
    try {
      config['cookies'] = JSON.parse(f.cookiesJson || '[]');
    } catch {
      alert('Invalid cookies JSON.');
      return;
    }
  }

  if (state.credentialEditing) {
    await api.put(`/credentials/${state.credentialEditing}`, {
      siteName: f.siteName,
      siteUrlPattern: f.siteUrlPattern,
      authMethod: f.authMethod,
      config,
    });
  } else {
    await api.post('/credentials', {
      siteName: f.siteName,
      siteUrlPattern: f.siteUrlPattern,
      authMethod: f.authMethod,
      config,
    });
  }

  state.credentialEditing = null;
  state.credentialForm = null;
  await loadCredentials();
  render();
}

async function deleteCredential(id: string) {
  if (!confirm('Delete this credential?')) return;
  await api.del(`/credentials/${id}`);
  await loadCredentials();
  render();
}

function renderImportField(label: string, key: string, placeholder: string, isSecret = false) {
  return h('div', null,
    h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, label),
    h('input', {
      type: isSecret ? 'password' : 'text',
      value: state.importConfig?.[key] || '',
      placeholder,
      style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
      onInput: (e: Event) => {
        state.importConfig = { ...(state.importConfig || {}), [key]: (e.target as HTMLInputElement).value };
      },
    })
  );
}

async function runPasswordImport() {
  if (!state.importProvider) return;
  state.importLoading = true;
  state.importResult = null;
  render();
  try {
    const body = {
      provider: state.importProvider,
      config: state.importConfig || {},
      search: state.importConfig?.search || undefined,
    };
    const r = await api.post('/password-providers/import', body);
    const data = await r.json();
    if (!r.ok) {
      state.importResult = { error: data?.error || 'Import failed' };
    } else {
      state.importResult = data;
      await loadCredentials();
    }
  } catch (e) {
    state.importResult = { error: (e as Error)?.message || 'Import failed' };
  } finally {
    state.importLoading = false;
    render();
  }
}

function renderImportPanel() {
  const labels: Record<string, string> = {
    '1password': '1Password',
    bitwarden: 'Bitwarden',
    apple_keychain: 'Apple Keychain',
    chrome: 'Chrome Passwords',
    csv: 'CSV Import',
  };
  const icons: Record<string, string> = {
    '1password': '🔑',
    bitwarden: '🛡',
    apple_keychain: '🍎',
    chrome: '🌐',
    csv: '📄',
  };

  const panel = h('div', { className: 'chart-box', style: 'margin-bottom:16px;border-color:#bfdbfe;background:linear-gradient(180deg,#f0f9ff,#ecfeff);' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;' },
      h('h3', { style: 'margin:0;' }, '📥 Import From Password Manager'),
      h('button', {
        className: 'row-btn',
        onClick: () => {
          state.importShow = false;
          state.importProvider = null;
          state.importConfig = {};
          state.importResult = null;
          render();
        },
      }, 'Close')
    )
  );

  if (!state.importProvider) {
    const providers = state.importProviders || [];
    panel.appendChild(h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;' },
      ...providers.map((p: any) => {
        const available = !!p?.available;
        return h('button', {
          style: `text-align:left;padding:10px;border-radius:10px;border:1px solid ${available ? '#bfdbfe' : '#e5e7eb'};background:${available ? '#ffffff' : '#f8fafc'};opacity:${available ? '1' : '.7'};cursor:${available ? 'pointer' : 'not-allowed'};`,
          title: p?.reason || '',
          onClick: available
            ? () => {
                state.importProvider = p.provider;
                state.importConfig = {};
                state.importResult = null;
                render();
              }
            : undefined,
        },
          h('div', { style: 'font-size:22px;margin-bottom:4px;' }, icons[p.provider] || '🔐'),
          h('div', { style: 'font-size:12px;font-weight:700;color:#0f172a;' }, labels[p.provider] || p.provider),
          h('div', { style: `font-size:11px;color:${available ? '#15803d' : '#b91c1c'};` }, available ? (p.version || 'Available') : 'Unavailable')
        );
      })
    ));
    return panel;
  }

  const selected = state.importProvider as string;
  panel.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:10px;' },
    h('button', {
      className: 'row-btn',
      onClick: () => {
        state.importProvider = null;
        state.importConfig = {};
        state.importResult = null;
        render();
      },
    }, 'Back'),
    h('div', { style: 'font-size:13px;font-weight:700;color:#0f172a;' }, labels[selected] || selected)
  ));

  const configWrap = h('div', { style: 'display:grid;gap:10px;margin-bottom:12px;' });
  if (selected === '1password') {
    configWrap.appendChild(renderImportField('Service Account Token', 'serviceAccountToken', 'OP_SERVICE_ACCOUNT_TOKEN', true));
  } else if (selected === 'bitwarden') {
    configWrap.appendChild(renderImportField('Master Password', 'password', 'Bitwarden master password', true));
    configWrap.appendChild(renderImportField('Client ID (optional)', 'clientId', 'BW_CLIENTID'));
    configWrap.appendChild(renderImportField('Client Secret (optional)', 'clientSecret', 'BW_CLIENTSECRET', true));
  } else if (selected === 'csv') {
    configWrap.appendChild(h('div', null,
      h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'CSV Content'),
      h('textarea', {
        rows: '6',
        placeholder: 'Paste CSV export content here...',
        value: state.importConfig?.csvContent || '',
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
        onInput: (e: Event) => {
          state.importConfig = { ...(state.importConfig || {}), csvContent: (e.target as HTMLTextAreaElement).value };
        },
      })
    ));
  }
  configWrap.appendChild(renderImportField('Search Filter (optional)', 'search', 'Import only matching entries'));
  panel.appendChild(configWrap);

  panel.appendChild(h('div', { style: 'display:flex;align-items:center;gap:10px;' },
    h('button', {
      className: 'nav-btn active',
      onClick: () => { void runPasswordImport(); },
      disabled: state.importLoading ? 'true' : undefined,
    }, state.importLoading ? 'Importing...' : 'Import Credentials'),
    state.importResult?.error
      ? h('span', { style: 'font-size:12px;color:#b91c1c;' }, `Error: ${state.importResult.error}`)
      : state.importResult
        ? h('span', { style: 'font-size:12px;color:#15803d;' }, `Imported ${state.importResult.imported || 0} of ${state.importResult.total || 0}`)
        : null
  ));

  return panel;
}

function renderCredentialForm() {
  const f = state.credentialForm || {};
  const isEdit = !!state.credentialEditing;
  return h('div', { className: 'chart-box', style: 'margin-bottom:16px;' },
    h('h3', null, isEdit ? 'Edit Browser Credential' : 'New Browser Credential'),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;' },
      h('div', null,
        h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'Site Name'),
        h('input', {
          value: f.siteName || '',
          onInput: (e: Event) => {
            state.credentialForm = { ...f, siteName: (e.target as HTMLInputElement).value };
          },
          style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        })
      ),
      h('div', null,
        h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'URL Pattern'),
        h('input', {
          value: f.siteUrlPattern || '',
          onInput: (e: Event) => {
            state.credentialForm = { ...f, siteUrlPattern: (e.target as HTMLInputElement).value };
          },
          style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        })
      ),
      h('div', { style: 'grid-column:1/-1;' },
        h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'Auth Method'),
        h('select', {
          value: f.authMethod || 'form_fill',
          onChange: (e: Event) => {
            state.credentialForm = { ...f, authMethod: (e.target as HTMLSelectElement).value };
            render();
          },
          style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        },
          h('option', { value: 'form_fill' }, 'Form Fill (username/password)'),
          h('option', { value: 'header' }, 'Header Auth'),
          h('option', { value: 'cookie' }, 'Cookie Injection')
        )
      ),
      (f.authMethod || 'form_fill') === 'form_fill'
        ? h('div', { style: 'grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:10px;' },
            h('input', {
              type: 'text',
              placeholder: 'Username',
              value: f.username || '',
              onInput: (e: Event) => {
                state.credentialForm = { ...f, username: (e.target as HTMLInputElement).value };
              },
              style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
            }),
            h('input', {
              type: 'password',
              placeholder: 'Password',
              value: f.password || '',
              onInput: (e: Event) => {
                state.credentialForm = { ...f, password: (e.target as HTMLInputElement).value };
              },
              style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
            })
          )
        : null,
      (f.authMethod || 'form_fill') === 'header'
        ? h('div', { style: 'grid-column:1/-1;' },
            h('input', {
              type: 'password',
              placeholder: 'Authorization header value',
              value: f.headerValue || '',
              onInput: (e: Event) => {
                state.credentialForm = { ...f, headerValue: (e.target as HTMLInputElement).value };
              },
              style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
            })
          )
        : null,
      (f.authMethod || 'form_fill') === 'cookie'
        ? h('div', { style: 'grid-column:1/-1;' },
            h('textarea', {
              rows: '4',
              placeholder: '[{"name":"session","value":"...","domain":".example.com"}]',
              value: f.cookiesJson || '[]',
              onInput: (e: Event) => {
                state.credentialForm = { ...f, cookiesJson: (e.target as HTMLTextAreaElement).value };
              },
              style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
            })
          )
        : null
    ),
    h('div', { style: 'display:flex;gap:8px;margin-top:12px;' },
      h('button', { className: 'nav-btn active', onClick: () => { void saveCredential(); } }, isEdit ? 'Update' : 'Save'),
      h('button', {
        className: 'nav-btn',
        onClick: () => {
          state.credentialForm = null;
          state.credentialEditing = null;
          render();
        },
      }, 'Cancel')
    )
  );
}

function renderCredentialsSection() {
  const wrap = h('div', { style: 'margin-top:28px;' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
      h('div', null,
        h('h3', { style: 'margin:0 0 2px;font-size:15px;color:var(--fg);' }, '🔒 Browser Passwords'),
        h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' }, 'Credentials used by browser tools for auto-login')
      ),
      h('div', { style: 'display:flex;gap:8px;' },
        h('button', {
          className: 'nav-btn',
          onClick: () => {
            state.importShow = !state.importShow;
            state.importProvider = null;
            state.importConfig = {};
            state.importResult = null;
            if (state.importShow) {
              void loadPasswordProviders();
            }
            render();
          },
        }, 'Import'),
        h('button', { className: 'nav-btn active', onClick: () => startAddCredential() }, '+ Add Credential')
      )
    )
  );

  if (state.importShow) {
    wrap.appendChild(renderImportPanel());
  }

  if (state.credentialForm) {
    wrap.appendChild(renderCredentialForm());
  }

  const creds = state.credentials || [];
  if (!creds.length && !state.credentialForm) {
    wrap.appendChild(h('div', { className: 'chart-box' }, h('div', { style: 'font-size:13px;color:var(--fg2);' }, 'No browser credentials saved yet.')));
    return wrap;
  }

  const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;' });
  creds.forEach((cred: any) => {
    grid.appendChild(h('div', { className: 'card', style: 'padding:16px;' },
      h('div', { style: 'font-weight:700;color:var(--fg);font-size:14px;margin-bottom:4px;' }, cred.siteName || 'Site'),
      h('div', { style: 'font-family:var(--mono);font-size:11px;color:var(--fg3);margin-bottom:8px;word-break:break-all;' }, cred.siteUrlPattern || ''),
      h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:10px;' }, `Method: ${cred.authMethod || 'unknown'}`),
      h('div', { className: 'row-actions' },
        h('button', { className: 'row-btn row-btn-edit', onClick: () => startEditCredential(cred) }, 'Edit'),
        h('button', { className: 'row-btn row-btn-del', onClick: () => { void deleteCredential(cred.id); } }, 'Delete')
      )
    ));
  });
  wrap.appendChild(grid);
  return wrap;
}

function renderLinkedAccountsSection() {
  const panel = h('div', { style: 'margin-top:20px;display:grid;grid-template-columns:1fr 1fr;gap:14px;' });

  const sso = state.ssoProviders || [];
  panel.appendChild(h('div', { className: 'chart-box' },
    h('h3', null, '🔐 Linked SSO Providers'),
    sso.length
      ? h('div', { style: 'display:flex;flex-direction:column;gap:8px;' },
          ...sso.map((p: any) =>
            h('div', { style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg3);font-size:12px;color:var(--fg2);' },
              `${p.providerName || p.name || 'Provider'} • ${p.status || 'active'}`
            )
          )
        )
      : h('div', { style: 'font-size:12px;color:var(--fg3);' }, 'No linked SSO providers')
  ));

  const oauth = state.oauthAccounts || [];
  panel.appendChild(h('div', { className: 'chart-box' },
    h('h3', null, '🔗 Linked OAuth Accounts'),
    oauth.length
      ? h('div', { style: 'display:flex;flex-direction:column;gap:8px;' },
          ...oauth.map((a: any) =>
            h('div', { style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg3);font-size:12px;color:var(--fg2);' },
              `${a.provider || 'Provider'} • ${a.account_email || a.account_id || 'Connected'}`
            )
          )
        )
      : h('div', { style: 'font-size:12px;color:var(--fg3);' }, 'No linked OAuth accounts')
  ));

  return panel;
}

function renderConnectorsView() {
  const view = h('div', { className: 'dash-view' });
  view.appendChild(h('h2', null, '⚡ Connectors'));

  if (state.connectorsLoading) {
    view.appendChild(h('div', { className: 'empty-chat' }, 'Loading connectors...'));
    return view;
  }

  view.appendChild(h('div', { style: 'margin-bottom:24px' },
    h('h3', { style: 'font-size:16px;font-weight:700;margin-bottom:12px;color:var(--fg);' }, '🏢 Enterprise'),
    h('p', { style: 'font-size:13px;color:var(--fg2);margin-bottom:16px;' }, 'Connect business tools and integrations'),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;' },
      ...CONNECTOR_DEFS.filter((d) => d.category === 'enterprise').map((def: any) => {
        const existing = getConnectorStatus(def);
        const connected = existing && existing.status === 'connected';
        return h('div', { className: 'card', style: 'padding:20px;' },
          h('div', { className: 'label' }, def.label),
          h('div', { style: 'font-size:14px;color:var(--fg);margin-bottom:8px;font-weight:600;' }, connected ? 'Connected' : 'Not connected'),
          h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:16px;line-height:1.5;' }, def.desc),
          connected
            ? h('div', { style: 'display:flex;gap:8px;' },
                h('button', { className: 'row-btn row-btn-edit', style: 'flex:1;', onClick: () => { void connectorTest(def); } }, 'Test'),
                h('button', { className: 'row-btn row-btn-del', style: 'flex:1;', onClick: () => { void connectorDisconnect(def); } }, 'Disconnect')
              )
            : h('button', { className: 'nav-btn active', style: `width:100%;background:${def.color};border-color:${def.color};`, onClick: () => { void connectorConnect(def); } }, 'Connect')
        );
      })
    )
  ));

  view.appendChild(h('div', { style: 'margin-bottom:24px' },
    h('h3', { style: 'font-size:16px;font-weight:700;margin-bottom:12px;color:var(--fg);' }, '📱 Social Media'),
    h('p', { style: 'font-size:13px;color:var(--fg2);margin-bottom:16px;' }, 'Connect social platforms and messaging services'),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;' },
      ...CONNECTOR_DEFS.filter((d) => d.category === 'social').map((def: any) => {
        const existing = getConnectorStatus(def);
        const connected = existing && existing.status === 'connected';
        return h('div', { className: 'card', style: 'padding:20px;' },
          h('div', { className: 'label' }, def.label),
          h('div', { style: 'font-size:14px;color:var(--fg);margin-bottom:8px;font-weight:600;' }, connected ? 'Connected' : 'Not connected'),
          h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:16px;line-height:1.5;' }, def.desc),
          connected
            ? h('div', { style: 'display:flex;gap:8px;' },
                h('button', { className: 'row-btn row-btn-edit', style: 'flex:1;', onClick: () => { void connectorTest(def); } }, 'Test'),
                h('button', { className: 'row-btn row-btn-del', style: 'flex:1;', onClick: () => { void connectorDisconnect(def); } }, 'Disconnect')
              )
            : h('button', { className: 'nav-btn active', style: `width:100%;background:${def.color};border-color:${def.color};`, onClick: () => { void connectorConnect(def); } }, 'Connect')
        );
      })
    )
  ));

  view.appendChild(renderCredentialsSection());
  view.appendChild(renderLinkedAccountsSection());

  return view;
}

function renderPreferencesView() {
  const view = h('div', { className: 'dash-view' },
    h('h2', null, '⚙ Preferences')
  );

  // Theme selection
  view.appendChild(h('div', { className: 'chart-box', style: 'max-width:760px;' },
    h('h3', null, 'Appearance'),
    h('p', { style: 'font-size:13px;line-height:1.6;color:var(--fg2);margin-bottom:16px;' }, 'Choose how geneWeave looks for your account'),
    h('div', { style: 'display:flex;gap:12px;margin-bottom:16px;' },
      h('button', {
        className: 'nav-btn' + (state.theme === 'light' ? ' active' : ''),
        style: 'flex:1;',
        onClick: () => {
          state.theme = 'light';
          document.documentElement.setAttribute('data-theme', 'light');
          render();
        }
      }, '☀ Light'),
      h('button', {
        className: 'nav-btn' + (state.theme === 'dark' ? ' active' : ''),
        style: 'flex:1;',
        onClick: () => {
          state.theme = 'dark';
          document.documentElement.setAttribute('data-theme', 'dark');
          render();
        }
      }, '🌙 Dark')
    ),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;' },
      h('div', { className: 'card', style: 'padding:18px;' },
        h('div', { className: 'label' }, 'Current Theme'),
        h('div', { style: 'font-size:20px;font-weight:700;color:var(--fg);margin-bottom:8px;' }, state.theme === 'dark' ? '🌙 Dark' : '☀ Light'),
        h('div', { style: 'font-size:12px;color:var(--fg2);line-height:1.6;' }, state.theme === 'dark' ? 'Dark mode for reduced glare' : 'Light mode for better visibility')
      ),
      h('div', { className: 'card', style: 'padding:18px;' },
        h('div', { className: 'label' }, 'Account'),
        h('div', { style: 'font-size:15px;font-weight:700;color:var(--fg);margin-bottom:4px;' }, state.user?.name || 'User'),
        h('div', { style: 'font-size:12px;color:var(--fg2);line-height:1.6;' }, state.user?.email || 'No email')
      )
    )
  ));

  return view;
}

function renderHomeWorkspace() {
  const center = h('section', {className:'center-card'},
    h('div', {className:'center-card-hdr'},
      h('div', {className:'agent-strip'},
        h('div', {className:'lead'}, h('img', {src:getAgentAvatarUrl('geneweave-supervisor')}), h('span',null,'geneWeave Agent'))
      ),
      h('div', {style:'display:flex;align-items:center;gap:8px'},
        h('div', {className:'title'}, (state.chats.find((c: Chat) => c.id === state.currentChatId)?.title) || 'Conversation')
      )
    ),
    renderChatView()
  );

  const rightRail = h('aside', { className: 'right-rail' },
    renderCalendarWidget(),
    renderActionsWidget()
  );

  return h('div', {className:'workspace-home'},
    renderWorkspaceTopCard(),
    h('div', { className: 'workspace-body' }, center, rightRail)
  );
}

function renderApp() {
  const wrap = h('div', {className:'app'});
  wrap.appendChild(renderWorkspaceNav());
  
  const main = h('div', {className:'main'});
  if (state.view === 'dashboard') {
    main.appendChild(renderDashboardView());
  } else if (state.view === 'admin') {
    main.appendChild(renderAdminView());
  } else if (state.view === 'connectors') {
    main.appendChild(renderConnectorsView());
  } else if (state.view === 'preferences') {
    main.appendChild(renderPreferencesView());
  } else {
    main.appendChild(renderHomeWorkspace());
  }
  wrap.appendChild(main);
  
  return wrap;
}

// Global render function
function render() {
  document.querySelectorAll('body > .dropdown').forEach((el) => el.remove());
  const root = document.getElementById('root');
  if (!root) return;
  
  if (!state.user) {
    root.innerHTML = '';
    root.appendChild(renderAuth());
  } else {
    root.innerHTML = '';
    root.appendChild(renderApp());
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

export function initialize() {
  document.addEventListener('click', () => {
    if (state.showSettings || state.showProfile || state.showNotifications) {
      state.showSettings = false;
      state.showProfile = false;
      state.showNotifications = false;
      render();
    }
  });

  // Check authentication and load data
  (async () => {
    try {
      const r = await api.get('/auth/check');
      if (r && typeof r === 'object' && 'ok' in r && (r as Response).ok) {
        const d = await (r as Response).json() as any;
        if (d.authenticated) {
        state.user = d.user;
        state.csrfToken = d.csrfToken;
        await loadChats();
        await Promise.all([loadModels(), loadTools(), loadUserPreferences()]);
        }
      }
      render();
    } catch (e) {
      console.error('Initialization failed:', e);
      render();
    }
  })();
}

// Make functions globally available
(globalThis as any).render = render;
(globalThis as any).sendMessage = sendMessage;
(globalThis as any).createChat = createChat;
(globalThis as any).selectChat = selectChat;
(globalThis as any).doLogout = doLogout;
(globalThis as any).initialize = initialize;
