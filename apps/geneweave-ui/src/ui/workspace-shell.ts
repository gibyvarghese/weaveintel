import { h } from './dom.js';
import {
  state,
  getCalendarFocusDate,
  setCalendarFocusDate,
  shiftCalendarMonth,
  toYMD,
  getTodayLabel,
  type ActionFeedItem,
  type AgendaItem,
} from './state.js';
import { getUserAvatarUrl } from './utils.js';
import { pushAdminHash } from './admin-ui.js';
import { bucketItems, bucketLabel, BUCKET_ORDER, itemCategoryColor, formatItemTime, quickAddAgendaItem } from './agenda-api.js';
import type { Chat } from './types.js';

function renderSidebarIcon(kind: 'home' | 'connectors' | 'admin' | 'dashboard' | 'calendar' | 'notes') {
  const iconMap: Record<string, string> = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.8V21h13V9.8"/><path d="M9.5 21v-6h5v6"/></svg>',
    connectors: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h4a2 2 0 0 1 2 2v0"/><path d="M17 17h-4a2 2 0 0 1-2-2v0"/><rect x="3" y="4" width="4" height="6" rx="1.2"/><rect x="17" y="14" width="4" height="6" rx="1.2"/></svg>',
    admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a1.7 1.7 0 1 1-3.4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a1.7 1.7 0 1 1 0-3.4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1 1 0 0 0 1.1.2h0a1 1 0 0 0 .6-.9V4a1.7 1.7 0 1 1 3.4 0v.2a1 1 0 0 0 .6.9h0a1 1 0 0 0 1.1-.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1 1 0 0 0-.2 1.1v0a1 1 0 0 0 .9.6H20a1.7 1.7 0 1 1 0 3.4h-.2a1 1 0 0 0-.9.6z"/></svg>',
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.2"/><rect x="13" y="3" width="8" height="5" rx="1.2"/><rect x="13" y="10" width="8" height="11" rx="1.2"/><rect x="3" y="13" width="8" height="8" rx="1.2"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    notes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
  };
  return h('span', { className: 'side-icon', innerHTML: iconMap[kind] || iconMap['home'] });
}

export function renderWorkspaceNav(options: {
  render: () => void;
  openConnectorsView: () => void;
  loadDashboard: () => Promise<void>;
  loadAdmin: () => Promise<void>;
  clearAdminEditorState: () => void;
  selectChat: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
}): HTMLElement {
  if (typeof state.sidebarCollapsed !== 'boolean') {
    state.sidebarCollapsed = false;
  }

  const nav = h('aside', { className: state.sidebarCollapsed ? 'workspace-nav collapsed' : 'workspace-nav' });
  const navScroll = h('div', { className: 'workspace-nav-scroll' });
  navScroll.addEventListener('scroll', () => { state.sidebarScrollTop = navScroll.scrollTop; }, { passive: true });
  const scrollSidebarBy = (delta: number) => {
    navScroll.scrollBy({ top: delta, behavior: 'smooth' });
  };
  nav.appendChild(
    h('div', { className: 'brand' },
      h('span', { className: 'brand-mark' }, '✦'),
      h('span', { className: 'word' }, 'geneWeave'),
      h('button', {
        className: 'sidebar-collapse-btn',
        title: state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        onClick: (e: Event) => {
          e.stopPropagation();
          state.sidebarCollapsed = !state.sidebarCollapsed;
          if (state.sidebarCollapsed) {
            state.adminMenuExpanded = false;
          }
          options.render();
        },
      }, state.sidebarCollapsed ? '»' : '«')
    )
  );

  if (!state.sidebarCollapsed) {
    nav.appendChild(
      h('div', { className: 'sidebar-scroll-controls' },
        h('button', {
          className: 'sidebar-scroll-btn',
          title: 'Scroll up',
          onClick: () => scrollSidebarBy(-240),
        }, '↑'),
        h('button', {
          className: 'sidebar-scroll-btn',
          title: 'Scroll down',
          onClick: () => scrollSidebarBy(240),
        }, '↓')
      )
    );
  }

  const adminSchema = ((typeof window !== 'undefined' && (window as any).ADMIN_SCHEMA) || {}) as Record<string, any>;
  const adminTabs = Object.keys(adminSchema);
  const adminGroups = (((typeof window !== 'undefined' && (window as any).ADMIN_GROUPS) || []) as any[])
    .map((group: any) => ({
      key: String(group.key || group.label || 'group').toLowerCase().replace(/\s+/g, '-'),
      label: String(group.label || 'Group'),
      icon: String(group.icon || '▸'),
      tabs: Array.isArray(group.tabs)
        ? group.tabs.filter((tab: any) => adminTabs.includes(tab.key))
        : [],
    }))
    .filter((group: any) => group.tabs.length > 0);

  if (typeof state.adminMenuExpanded !== 'boolean') {
    state.adminMenuExpanded = false;
  }
  if (!state.adminGroupExpanded || typeof state.adminGroupExpanded !== 'object') {
    state.adminGroupExpanded = {};
  }

  adminGroups.forEach((group: any, index: number) => {
    if (typeof state.adminGroupExpanded[group.key] !== 'boolean') {
      state.adminGroupExpanded[group.key] = index === 0;
    }
  });

  const menu = h('div', { className: 'workspace-menu' });
  menu.appendChild(h('button', { className: state.view === 'chat' ? 'active' : '', title: 'Home', onClick: () => { state.view = 'chat'; options.render(); } },
    renderSidebarIcon('home'),
    h('span', { className: 'nav-label' }, 'Home')
  ));
  menu.appendChild(h('button', { className: state.view === 'calendar' ? 'active' : '', title: 'Calendar', onClick: () => { state.view = 'calendar'; options.render(); } },
    renderSidebarIcon('calendar'),
    h('span', { className: 'nav-label' }, 'Calendar')
  ));
  menu.appendChild(h('button', { className: state.view === 'notes' ? 'active' : '', title: 'Notes', onClick: () => { state.view = 'notes'; options.render(); } },
    renderSidebarIcon('notes'),
    h('span', { className: 'nav-label' }, 'Notes')
  ));
  menu.appendChild(h('button', { className: state.view === 'dashboard' ? 'active' : '', title: 'Dashboard', onClick: () => { state.view = 'dashboard'; void options.loadDashboard(); } },
    renderSidebarIcon('dashboard'),
    h('span', { className: 'nav-label' }, 'Dashboard')
  ));
  menu.appendChild(h('button', { className: state.view === 'connectors' ? 'active' : '', title: 'Connectors', onClick: () => { options.openConnectorsView(); } },
    renderSidebarIcon('connectors'),
    h('span', { className: 'nav-label' }, 'Connectors')
  ));
  menu.appendChild(h('button', {
    className: state.view === 'scientific-validation' ? 'active' : '',
    title: 'Scientific Validation',
    onClick: () => { state.view = 'scientific-validation'; options.render(); },
  },
    h('span', { className: 'side-icon', style: 'font-size:15px' }, '🔬'),
    h('span', { className: 'nav-label' }, 'Validation')
  ));
  menu.appendChild(h('button', {
    className: state.view === 'kaggle-competition' ? 'active' : '',
    title: 'Kaggle Competition',
    onClick: () => { state.view = 'kaggle-competition'; options.render(); },
  },
    h('span', { className: 'side-icon', style: 'font-size:15px' }, '🏆'),
    h('span', { className: 'nav-label' }, 'Kaggle')
  ));

  const adminNode = h('div', { className: 'admin-nav-tree' });
  const adminActive = state.view === 'admin';
  adminNode.appendChild(h('button', {
    className: adminActive ? 'active admin-parent' : 'admin-parent',
    onClick: () => {
      state.view = 'admin';
      state.adminMenuExpanded = !state.adminMenuExpanded;
      if (state.adminMenuExpanded && !state.adminTab && adminTabs.length) {
        state.adminTab = adminTabs[0];
      }
      options.render();
      void options.loadAdmin();
    },
  }, renderSidebarIcon('admin'), h('span', { className: 'nav-label' }, 'Admin'), h('span', { className: `admin-caret${state.adminMenuExpanded ? ' open' : ''}` }, '▾')));

  if (state.adminMenuExpanded && !state.sidebarCollapsed) {
    const sub = h('div', { className: 'admin-nav-sub' });
    adminGroups.forEach((group: any) => {
      const groupOpen = !!state.adminGroupExpanded[group.key];
      sub.appendChild(h('button', {
        className: 'admin-group-btn',
        onClick: () => {
          state.adminGroupExpanded[group.key] = !groupOpen;
          options.render();
        },
      }, h('span', { className: 'nav-label' }, group.label), h('span', { className: `admin-caret${groupOpen ? ' open' : ''}` }, '▾')));

      if (groupOpen) {
        const groupList = h('div', { className: 'admin-group-list' });
        group.tabs.forEach((tab: any) => {
          groupList.appendChild(h('button', {
            className: `admin-subtab${state.view === 'admin' && state.adminTab === tab.key ? ' active' : ''}`,
            'data-admin-tab': tab.key,
            onClick: () => {
              state.view = 'admin';
              if (state.adminTab !== tab.key) {
                state.adminTab = tab.key;
                options.clearAdminEditorState();
                state.promptWizard = null;
              }
              pushAdminHash(tab.key);
              options.render();
              void options.loadAdmin();
            },
          }, tab.label));
        });
        sub.appendChild(groupList);
      }
    });

    const orphanTabs = adminTabs.filter((tabKey) => !adminGroups.some((group: any) => group.tabs.some((tab: any) => tab.key === tabKey)));
    if (orphanTabs.length) {
      const groupList = h('div', { className: 'admin-group-list' });
      orphanTabs.forEach((tabKey) => {
        groupList.appendChild(h('button', {
          className: `admin-subtab${state.view === 'admin' && state.adminTab === tabKey ? ' active' : ''}`,
          'data-admin-tab': tabKey,
          onClick: () => {
            state.view = 'admin';
            if (state.adminTab !== tabKey) {
              state.adminTab = tabKey;
              options.clearAdminEditorState();
              state.promptWizard = null;
            }
            pushAdminHash(tabKey);
            options.render();
            void options.loadAdmin();
          },
        }, tabKey.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())));
      });
      sub.appendChild(groupList);
    }

    adminNode.appendChild(sub);
  }
  menu.appendChild(adminNode);
  navScroll.appendChild(menu);

  if (typeof state.recentChatsExpanded !== 'boolean') {
    state.recentChatsExpanded = true;
  }

  const history = h('div', { className: 'workspace-history' },
    h('button', {
      className: 'workspace-history-toggle',
      onClick: () => {
        state.recentChatsExpanded = !state.recentChatsExpanded;
        options.render();
      },
    },
      h('span', { className: 'workspace-history-label' }, 'Recent Chats'),
      h('span', { className: `admin-caret${state.recentChatsExpanded ? ' open' : ''}` }, '▾')
    ),
    ...(!state.sidebarCollapsed && state.recentChatsExpanded
      ? (state.chats.length
          ? state.chats.slice(0, 14).map((chat: Chat) =>
              h('div', {
                  className: 'chat-item' + (state.currentChatId === chat.id ? ' active' : ''),
                  onClick: () => {
                    state.view = 'chat';
                    if (state.currentChatId !== chat.id) void options.selectChat(chat.id);
                  },
                },
                h('div', { className: 'chat-item-copy' },
                  h('div', { className: 'chat-item-title' }, chat.title || 'New Chat'),
                  h('div', { className: 'chat-item-meta' }, new Date(chat.updated_at || chat.created_at || Date.now()).toLocaleString())
                ),
                h('button', {
                  className: 'del',
                  title: 'Delete chat',
                  onClick: (e: Event) => {
                    e.stopPropagation();
                    void options.deleteChat(chat.id);
                  },
                }, '×')
              )
            )
          : [h('div', { className: 'workspace-history-empty' }, 'No saved chats yet')])
      : [])
  );
  navScroll.appendChild(history);
  nav.appendChild(navScroll);
  return nav;
}

export function renderWorkspaceTopCard(options: {
  render: () => void;
  createChat: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  renderProfileDropdown: () => HTMLElement;
}): HTMLElement {
  const userName = (state.user?.name || 'User') as string;
  const userEmail = (state.user?.email || '') as string;
  const openProfile = (e: Event) => {
    e.stopPropagation();
    state.showNotifications = false;
    state.showProfile = !state.showProfile;
    options.render();
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
    const dd = options.renderProfileDropdown();
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
          options.render();
        },
      }),
      state.chatSearchQuery
        ? h(
            'div',
            { className: 'search-dd' },
            ...state.chats
              .filter((chat: Chat) =>
                (chat.title || '').toLowerCase().includes(String(state.chatSearchQuery).toLowerCase())
              )
              .slice(0, 8)
              .map((chat: Chat) =>
                h(
                  'div',
                  {
                    className: 'search-item',
                    onClick: () => {
                      state.chatSearchQuery = '';
                      void options.selectChat(chat.id);
                    },
                  },
                  h('div', { className: 'ttl' }, chat.title || 'New Chat'),
                  h(
                    'div',
                    { className: 'sub' },
                    new Date(chat.updated_at || chat.created_at || Date.now()).toLocaleString()
                  )
                )
              )
          )
        : null
    ),
    h('div', { className: 'top-actions' },
      h('button', {
        className: 'nav-btn',
        title: 'Developer Documentation',
        onClick: () => { window.open('/docs', '_blank', 'noopener'); },
      }, '? Docs'),
      h('button', { className: 'nav-btn', onClick: () => { void options.createChat(); } }, '+ New Chat'),
      profileAnchor
    )
  );
}

export function renderCalendarWidget(render: () => void): HTMLElement {
  const focus = getCalendarFocusDate();
  const year = focus.getFullYear();
  const month = focus.getMonth();
  const selectedYMD = toYMD(focus);

  // Dot counts per calendar day from real agenda items
  const items: AgendaItem[] = state.calendarItems ?? [];
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (item.start_at) {
      const ymd = item.start_at.slice(0, 10);
      counts[ymd] = (counts[ymd] ?? 0) + 1;
    }
  }

  const focusDays: Date[] = [];
  for (let i = -1; i <= 3; i++) focusDays.push(new Date(year, month, focus.getDate() + i));

  const monthFirst = new Date(year, month, 1);
  const monthLast = new Date(year, month + 1, 0);
  const monthCells: HTMLElement[] = [];
  for (let i = 0; i < monthFirst.getDay(); i++) monthCells.push(h('div', { className: 'md empty' }, ''));
  for (let day = 1; day <= monthLast.getDate(); day++) {
    const d = new Date(year, month, day);
    const dYMD = toYMD(d);
    monthCells.push(h('div', {
      className: `md${counts[dYMD] ? ' has' : ''}${dYMD === selectedYMD ? ' active' : ''}`,
      onClick: () => { setCalendarFocusDate(d); render(); },
    }, String(day)));
  }

  // Bucket view: items for the selected day and nearby (agenda-first)
  const focusYMD = toYMD(focus);
  const dayItems = items.filter((it) => it.start_at?.slice(0, 10) === focusYMD);
  const upcomingItems = items.filter((it) => {
    const ymd = it.start_at?.slice(0, 10);
    return ymd && ymd > focusYMD;
  }).slice(0, 5);
  const allDayItems = [...dayItems, ...upcomingItems];
  const bucketed = bucketItems(allDayItems.length > 0 ? allDayItems : items.slice(0, 20));

  const categories: import('./state.js').AgendaCategory[] = state.calendarCategories ?? [];

  const renderItemChip = (item: AgendaItem) => {
    const color = itemCategoryColor(item, categories);
    const timeLabel = formatItemTime(item);
    return h('div', { className: 'cal-item-chip', style: `border-left:3px solid ${color}` },
      h('div', { className: 'cal-item-title' }, item.title),
      timeLabel ? h('div', { className: 'cal-item-time' }, timeLabel) : null,
    );
  };

  const bucketSections: HTMLElement[] = [];
  for (const bucket of BUCKET_ORDER) {
    const list = bucketed.get(bucket);
    if (!list || list.length === 0) continue;
    bucketSections.push(
      h('div', { className: 'cal-bucket' },
        h('div', { className: 'cal-bucket-label' }, bucket),
        ...list.map(renderItemChip)
      )
    );
  }

  // Quick-add input (WC4)
  const quickAdd = h('div', { className: 'cal-quick-add' },
    h('input', {
      className: 'cal-qa-input',
      type: 'text',
      placeholder: 'Quick add… "dentist tomorrow at 3pm"',
      value: state.calendarQuickAdd as string,
      onInput: (e: Event) => { state.calendarQuickAdd = (e.target as HTMLInputElement).value; },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (state.calendarQuickAdd as string).trim()) {
          void quickAddAgendaItem({ nlText: (state.calendarQuickAdd as string).trim() }).then(() => render());
        }
      },
    }),
    h('button', {
      className: 'cal-qa-btn',
      disabled: state.calendarQuickAddLoading as boolean,
      onClick: () => {
        if ((state.calendarQuickAdd as string).trim()) {
          void quickAddAgendaItem({ nlText: (state.calendarQuickAdd as string).trim() }).then(() => render());
        }
      },
    }, state.calendarQuickAddLoading ? '…' : '+')
  );

  return h('div', { className: 'side-card schedule-card' },
    h('div', { className: 'schedule-head' },
      h('div', { className: 'ttl' }, '◷ Schedule'),
      h('div', { className: 'month-nav' },
        h('button', { className: 'icon-btn-sm', title: 'Previous month', onClick: () => { shiftCalendarMonth(-1); render(); } }, '‹'),
        h('div', { className: 'month-pill' }, focus.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })),
        h('button', { className: 'icon-btn-sm', title: 'Next month', onClick: () => { shiftCalendarMonth(1); render(); } }, '›')
      ),
      h('button', {
        className: 'see-all',
        title: 'Open full calendar',
        onClick: () => { state.view = 'calendar'; render(); },
      }, 'Full view')
    ),
    !state.calendarShowAll
      ? h('div', { className: 'day-strip' },
          ...focusDays.map((d) =>
            h('div', {
              className: `day-chip${toYMD(d) === selectedYMD ? ' active' : ''}`,
              title: `${counts[toYMD(d)] ?? 0} items`,
              onClick: () => { setCalendarFocusDate(d); render(); },
            },
            h('div', { className: 'dw' }, d.toLocaleDateString(undefined, { weekday: 'short' })),
            h('div', { className: 'dn' }, String(d.getDate()).padStart(2, '0'))
            )
          )
        )
      : h('div', { className: 'month-grid' },
          ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => h('div', { className: 'mh' }, x)),
          ...monthCells
        ),
    quickAdd,
    h('div', { className: 'cal-bucket-list' },
      ...bucketSections,
      bucketSections.length === 0
        ? h('div', { className: 'cal-empty' }, state.calendarLoading ? 'Loading…' : 'No upcoming items')
        : null
    ),
    h('div', { className: 'schedule-view-toggle' },
      h('button', { className: 'see-all', onClick: () => { state.calendarShowAll = !state.calendarShowAll; render(); } },
        state.calendarShowAll ? 'Hide month' : 'Month view')
    )
  );
}

const ACTION_BADGE_COLORS: Record<ActionFeedItem['type'], { bg: string; fg: string; label: string }> = {
  approval: { bg: '#3B82F6', fg: '#fff', label: 'Approve' },
  task:     { bg: '#8B5CF6', fg: '#fff', label: 'Task' },
  reminder: { bg: '#F59E0B', fg: '#fff', label: 'Remind' },
  agenda:   { bg: '#10B981', fg: '#fff', label: 'Agenda' },
};

const URGENCY_BORDER: Record<ActionFeedItem['urgency'], string> = {
  overdue:  '#EF4444',
  'due-soon': '#F59E0B',
  proposed: '#3B82F6',
  normal:   'transparent',
};

export function renderActionsWidget(selectChat: (chatId: string) => Promise<void>, render: () => void): HTMLElement {
  const feed = state.actionFeed as ActionFeedItem[];
  const filter = state.actionFeedFilter as string;

  const filtered = filter === 'all'
    ? feed
    : feed.filter((a) => a.type === filter);

  const filterBtn = (label: string, key: string) =>
    h('button', {
      className: `af-filter${filter === key ? ' active' : ''}`,
      onClick: () => { state.actionFeedFilter = key; render(); },
    }, label);

  const header = h('div', { className: 'af-header' },
    h('div', { className: 'af-title-row' },
      h('span', { className: 'af-title' }, 'My Actions'),
      state.actionFeedLoading
        ? h('span', { className: 'af-loading' }, '…')
        : h('span', { className: 'af-count' }, String(feed.length) + (feed.length === 1 ? ' item' : ' items'))
    ),
    h('div', { className: 'af-filters' },
      filterBtn('All', 'all'),
      filterBtn('Approvals', 'approval'),
      filterBtn('Tasks', 'task'),
      filterBtn('Reminders', 'reminder'),
    )
  );

  const list = h('div', { className: 'action-list' },
    ...filtered.slice(0, 10).map((item: ActionFeedItem) => {
      const badge = ACTION_BADGE_COLORS[item.type];
      const borderColor = URGENCY_BORDER[item.urgency];
      const isActive = state.currentChatId === item.conversationId;

      return h('div', {
        className: `action-item selectable${isActive ? ' active' : ''}`,
        style: `border-left:3px solid ${borderColor}`,
        onClick: () => {
          if (item.type === 'approval' && item.conversationId) {
            void selectChat(item.conversationId);
          }
        },
      },
        h('div', { className: 'af-row' },
          h('span', {
            className: 'af-badge',
            style: `background:${badge.bg};color:${badge.fg}`,
          }, badge.label),
          h('div', { className: 'af-body' },
            h('div', { className: 'at' }, item.title),
            h('div', { className: 'as' }, item.sub),
          )
        )
      );
    }),
    filtered.length === 0
      ? h('div', { className: 'action-item' }, h('div', { className: 'as' }, state.actionFeedLoading ? 'Loading…' : 'No actions'))
      : null,
    filtered.length > 10
      ? h('div', { className: 'af-more', onClick: () => { state.view = 'actions'; render(); } }, `+${filtered.length - 10} more`)
      : null,
  );

  return h('div', { className: 'side-card actions-card' }, header, list);
}

export function renderProfileDropdown(options: {
  render: () => void;
  doLogout: () => Promise<void>;
  loadDashboard: () => Promise<void>;
  loadAdmin: () => Promise<void>;
}): HTMLElement {
  const user = state.user || {};
  const avatar = h('img', {
    src: getUserAvatarUrl(),
    alt: user.name || 'User',
    style: 'width:48px;height:48px;border-radius:50%;object-fit:cover;margin-bottom:10px;',
  });

  return h('div', { className: 'dropdown profile-dd', onClick: (e: Event) => e.stopPropagation() },
    avatar,
    h('div', { className: 'pf-name' }, user.name || 'User'),
    h('div', { className: 'pf-email' }, user.email || ''),
    h('div', { className: 'pf-divider' }),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'preferences'; state.showProfile = false; options.render(); } }, '⚙ Preferences'),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'dashboard'; state.showProfile = false; options.render(); void options.loadDashboard(); } }, '📊 Dashboard'),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'admin'; state.adminMenuExpanded = true; state.showProfile = false; options.render(); void options.loadAdmin(); } }, '⚙ Admin'),
    h('div', { className: 'pf-divider' }),
    h('button', { className: 'pf-btn danger', onClick: async () => { state.showProfile = false; await options.doLogout(); options.render(); } }, '🚪 Sign Out')
  );
}

export function renderDashboardView(options: {
  render: () => void;
  loadAdmin: () => Promise<void>;
  formatCompactNumber: (value: number) => string;
  formatCurrencyCompact: (value: number, digits?: number) => string;
  formatMaybeCompactValue: (value: any) => string;
}): HTMLElement {
  const dashboard = state.dashboard;
  const view = h('div', { className: 'dash-view' }, h('h2', null, 'Dashboard'));
  if (!dashboard || !dashboard.overview) {
    view.appendChild(h('div', { className: 'empty-chat' }, 'Loading dashboard...'));
    return view;
  }

  const summary = dashboard.overview.summary || {};
  const executionCount = Array.isArray(dashboard.agentActivity) ? dashboard.agentActivity.length : 0;
  const traceCount = Array.isArray(dashboard.traces) ? dashboard.traces.length : 0;
  const evalRunCount = Array.isArray(dashboard.evals?.evals) ? dashboard.evals.evals.length : 0;
  view.appendChild(
    h('div', { className: 'cards' },
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Executions'), h('div', { className: 'value' }, options.formatCompactNumber(executionCount))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Total Tokens'), h('div', { className: 'value tokens' }, options.formatCompactNumber(Number(summary.total_tokens || 0)))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Total Cost'), h('div', { className: 'value cost' }, options.formatCurrencyCompact(Number(summary.total_cost || 0), 4))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Avg Latency'), h('div', { className: 'value latency' }, options.formatMaybeCompactValue(summary.avg_latency_ms || 0) + 'ms')),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Messages'), h('div', { className: 'value' }, options.formatCompactNumber(Number(summary.total_messages || 0)))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Chats'), h('div', { className: 'value' }, options.formatCompactNumber(Number(summary.total_chats || 0)))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Eval Runs'), h('div', { className: 'value' }, options.formatCompactNumber(evalRunCount))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Traces'), h('div', { className: 'value' }, options.formatCompactNumber(traceCount)))
    )
  );

  view.appendChild(
    h('div', { className: 'table-wrap', style: 'margin-top:12px;' },
      h('div', { style: 'padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;' },
        h('div', { style: 'font-size:12px;color:var(--fg2);' }, 'For traces, flow details, and evaluation diagnostics use Monitoring in Admin.'),
        h('button', {
          className: 'nav-btn',
          onClick: () => {
            state.view = 'admin';
            state.adminMenuExpanded = true;
            state.adminGroupExpanded['monitoring'] = true;
            state.adminTab = 'workflow-runs';
            options.render();
            void options.loadAdmin();
          },
        }, 'Open Monitoring')
      )
    )
  );

  return view;
}