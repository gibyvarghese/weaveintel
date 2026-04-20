// Global UI state object
import type { User, Chat, Message, Model, ChatSettings } from './types.js';

export const state: any = {
  // Auth & user
  user: null as User | null,
  csrfToken: '',
  authMode: 'login',
  authError: '',

  // Current view
  view: 'chat',

  // Chat management
  currentChatId: null as string | null,
  chats: [] as Chat[],
  messages: [] as Message[],
  streaming: false,
  pendingDraft: '',
  pendingAttachments: [] as any[],

  // Models & settings
  models: [] as Model[],
  selectedModel: 'openai:gpt-4o' as string,
  tools: [] as any[],
  defaultMode: 'direct',
  chatSettings: null as ChatSettings | null,

  // Theme
  theme: 'dark',

  // UI state
  showProfile: false,
  showNotifications: false,
  showSettings: false,
  recentChatsExpanded: true,
  sidebarCollapsed: false,
  sidebarScrollTop: 0,

  // Calendar
  calendarTab: 'meetings',
  calendarShowAll: false,
  calendarFocusDate: new Date(),

  // Admin
  adminTab: 'prompts',
  adminData: {} as Record<string, any[]>,
  adminForm: {} as Record<string, any>,
  adminEditing: null as string | null,
  adminMenuExpanded: false,
  adminGroupExpanded: {} as Record<string, boolean>,

  // Admin list controls (search / sort / group / page)
  adminListCurrentTab: '' as string,
  adminListSearch: '' as string,
  adminListSortCol: null as string | null,
  adminListSortDir: 'asc' as 'asc' | 'desc',
  adminListGroupBy: '' as string,
  adminListPage: 1 as number,
  adminListGroupCollapsed: {} as Record<string, boolean>,

  // Connectors
  connectors: { enterprise: [] as any[], social: [] as any[] },
  connectorsLoading: false,

  // Credentials
  credentials: [] as any[],
  credentialForm: null as any,
  credentialEditing: null as string | null,
  importShow: false,
  importProvider: null,
  importConfig: {} as Record<string, any>,
  importLoading: false,
  importResult: null as any,
  importProviders: [] as any[],

  // SSO & OAuth
  ssoProviders: [] as any[],
  oauthAccounts: [] as any[],

  // Dashboard
  dashboard: null as any,

  // Search
  chatSearchQuery: '',
  chatSearchResults: [] as any[],
  chatSearchLoading: false,
  _chatSearchTimer: null as any,

  // Audio recording
  audioRecording: false,

  // Handoff
  handoffRequest: null as any,

  // Metadata
  _aboutInfo: null as any,
  _upgradeStatus: null,
  _upgradeMsg: '',
};

// Helper to get calendar focus date
export function getCalendarFocusDate(): Date {
  return state.calendarFocusDate || new Date();
}

export function setCalendarFocusDate(date: Date): void {
  state.calendarFocusDate = new Date(date);
}

export function shiftCalendarMonth(offset?: number): void {
  const d = getCalendarFocusDate();
  const shift = offset || 0;
  state.calendarFocusDate = new Date(d.getFullYear(), d.getMonth() + shift, 1);
}

// Convert date to YYYY-MM-DD
export function toYMD(d: Date | null): string {
  if (!d) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Parse YYYY-MM-DD to Date
export function fromYMD(ymd: string): Date {
  if (!ymd || ymd.length !== 10) return new Date();
  const parts = ymd.split('-').map(Number) as [number, number, number];
  const [year, month, day] = parts;
  return new Date(year, month - 1, day);
}

// Get today label
export function getTodayLabel(): string {
  const today = new Date();
  return today.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
