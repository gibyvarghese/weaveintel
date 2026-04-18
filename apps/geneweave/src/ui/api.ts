// API client for backend communication
import { state } from './state.js';
import { ADMIN_TABS } from '../admin-schema.js';

function triggerRender() {
  (globalThis as any).render?.();
}

// CSRF token management
function getCsrfToken(): string {
  return state.csrfToken || '';
}

// Generic fetch wrapper with CSRF support
async function fetchWithCsrf(url: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  if (getCsrfToken()) {
    headers.set('X-CSRF-Token', getCsrfToken());
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  return response;
}

export const api = {
  // GET
  get: async (path: string) => {
    const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : '/' + path}`;
    return fetchWithCsrf(url);
  },

  // POST
  post: async (path: string, body: any = {}) => {
    const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : '/' + path}`;
    return fetchWithCsrf(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // PUT
  put: async (path: string, body: any = {}) => {
    const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : '/' + path}`;
    return fetchWithCsrf(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  // DELETE
  del: async (path: string) => {
    const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : '/' + path}`;
    return fetchWithCsrf(url, {
      method: 'DELETE',
    });
  },
};

function parseMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeServerMessage(message: any) {
  const meta = parseMetadata(message?.metadata);
  return {
    ...message,
    metadata: message?.metadata ?? null,
    attachments: Array.isArray(message?.attachments)
      ? message.attachments
      : Array.isArray(meta['attachments'])
        ? meta['attachments']
        : [],
    steps: Array.isArray(message?.steps)
      ? message.steps
      : Array.isArray(meta['steps'])
        ? meta['steps']
        : [],
    evalResult: message?.evalResult ?? meta['eval'] ?? null,
    cognitive: message?.cognitive ?? meta['cognitive'] ?? null,
    guardrail: message?.guardrail ?? meta['guardrail'] ?? null,
    activeSkills: Array.isArray(message?.activeSkills)
      ? message.activeSkills
      : Array.isArray(meta['activeSkills'])
        ? meta['activeSkills']
        : [],
    skillTools: Array.isArray(message?.skillTools)
      ? message.skillTools
      : Array.isArray(meta['skillTools'])
        ? meta['skillTools']
        : [],
    enabledTools: Array.isArray(message?.enabledTools)
      ? message.enabledTools
      : Array.isArray(meta['enabledTools'])
        ? meta['enabledTools']
        : [],
    skillPromptApplied: message?.skillPromptApplied ?? !!meta['skillPromptApplied'],
    mode: message?.mode ?? meta['mode'] ?? null,
  };
}

// Chat operations
export async function loadChats() {
  try {
    const r = await api.get('/chats');
    const data = await r.json();
    state.chats = data.chats || [];
    const hasCurrent = state.currentChatId && state.chats.some((chat: any) => chat.id === state.currentChatId);
    if (!hasCurrent) {
      state.currentChatId = state.chats[0]?.id || null;
      state.messages = [];
    }
    if (state.currentChatId && state.messages.length === 0) {
      const [messagesResp] = await Promise.all([
        api.get(`/chats/${state.currentChatId}/messages`),
        loadChatSettings(state.currentChatId),
      ]);
      const messagesData = await messagesResp.json();
      state.messages = Array.isArray(messagesData.messages)
        ? messagesData.messages.map(normalizeServerMessage)
        : [];
    }
    triggerRender();
  } catch (e) {
    console.error('Failed to load chats', e);
  }
}

export async function selectChat(id: string) {
  state.currentChatId = id;
  triggerRender();
  try {
    const [messagesResp, _settingsResp] = await Promise.all([
      api.get(`/chats/${id}/messages`),
      loadChatSettings(id),
    ]);
    const data = await messagesResp.json();
    state.messages = Array.isArray(data.messages)
      ? data.messages.map(normalizeServerMessage)
      : [];
    triggerRender();
  } catch (e) {
    console.error('Failed to load chat', e);
  }
}

export async function createChat() {
  try {
    const parts = String(state.selectedModel || '').split(':');
    const r = await api.post('/chats', {
      model: parts[1] || state.selectedModel,
      provider: parts[0] || '',
    });
    const data = await r.json();
    const chat = data.chat;
    if (chat) {
      state.chats.unshift(chat);
      state.currentChatId = chat.id;
      state.messages = [];
      await loadChatSettings(chat.id);
      if (state.chatSettings && state.defaultMode) {
        state.chatSettings.mode = state.defaultMode;
        await saveChatSettings();
      }
      triggerRender();
    }
  } catch (e) {
    console.error('Failed to create chat', e);
  }
}

export async function deleteChat(id: string) {
  if (!confirm('Delete this chat?')) return;
  try {
    await api.del(`/chats/${id}`);
    state.chats = state.chats.filter((c: any) => c.id !== id);
    if (state.currentChatId === id) {
      state.currentChatId = state.chats[0]?.id || null;
      state.messages = [];
    }
    triggerRender();
  } catch (e) {
    console.error('Failed to delete chat', e);
  }
}

// Models & tools
export async function loadModels() {
  try {
    const r = await api.get('/models');
    const data = await r.json();
    state.models = data.models || [];
    if (!state.selectedModel && data.defaultModel) {
      state.selectedModel = data.defaultModel;
    }
    triggerRender();
  } catch (e) {
    console.error('Failed to load models', e);
  }
}

export async function loadTools() {
  try {
    const r = await api.get('/tools');
    const data = await r.json();
    state.tools = data.tools || [];
    triggerRender();
  } catch (e) {
    console.error('Failed to load tools', e);
  }
}

// User preferences
export async function loadUserPreferences() {
  try {
    const r = await api.get('/user/preferences');
    const data = await r.json();
    if (data.preferences?.theme) state.theme = data.preferences.theme;
    if (data.preferences?.default_mode) state.defaultMode = data.preferences.default_mode;
    triggerRender();
  } catch (e) {
    console.error('Failed to load preferences', e);
  }
}

// Chat-specific settings
export async function loadChatSettings(chatId: string) {
  if (!chatId) {
    state.chatSettings = null;
    triggerRender();
    return;
  }
  try {
    const r = await api.get(`/chats/${chatId}/settings`);
    const data = await r.json();
    const settings = data.settings;
    state.chatSettings = settings
      ? {
          mode: settings.mode || 'direct',
          systemPrompt: settings.system_prompt || '',
          timezone: settings.timezone || '',
          enabledTools: settings.enabled_tools ? JSON.parse(settings.enabled_tools) : [],
          redactionEnabled: !!settings.redaction_enabled,
          redactionPatterns: settings.redaction_patterns ? JSON.parse(settings.redaction_patterns) : ['email', 'phone', 'ssn', 'credit_card'],
          workers: settings.workers ? JSON.parse(settings.workers) : [],
        }
      : {
          mode: state.defaultMode || 'direct',
          systemPrompt: '',
          timezone: '',
          enabledTools: [],
          redactionEnabled: false,
          redactionPatterns: ['email', 'phone', 'ssn', 'credit_card'],
          workers: [],
        };
    triggerRender();
  } catch (e) {
    console.error('Failed to load chat settings', e);
    state.chatSettings = {
      mode: state.defaultMode || 'direct',
      systemPrompt: '',
      timezone: '',
      enabledTools: [],
      redactionEnabled: false,
      redactionPatterns: ['email', 'phone', 'ssn', 'credit_card'],
      workers: [],
    };
    triggerRender();
  }
}

export async function saveChatSettings() {
  if (!state.currentChatId || !state.chatSettings) return;
  try {
    await api.post(`/chats/${state.currentChatId}/settings`, state.chatSettings);
    if (state.chatSettings.mode && state.chatSettings.mode !== state.defaultMode) {
      state.defaultMode = state.chatSettings.mode;
      await api.post('/user/preferences', { default_mode: state.chatSettings.mode, theme: state.theme });
    }
  } catch (e) {
    console.error('Failed to save chat settings', e);
  }
}

// Dashboard
export async function loadDashboard() {
  state.view = 'dashboard';
  try {
    const [overview, costs, performance, evals, traces, activity] = await Promise.all([
      api.get('/dashboard/overview').then((r) => r.json()),
      api.get('/dashboard/costs').then((r) => r.json()),
      api.get('/dashboard/performance').then((r) => r.json()),
      api.get('/dashboard/evals').then((r) => r.json()),
      api.get('/dashboard/traces?limit=50').then((r) => (r.ok ? r.json() : { traces: [] })).catch(() => ({ traces: [] })),
      api.get('/dashboard/agent-activity?limit=50').then((r) => (r.ok ? r.json() : { activity: [] })).catch(() => ({ activity: [] })),
    ]);
    state.dashboard = {
      overview,
      costs,
      performance,
      evals,
      traces: traces.traces || [],
      agentActivity: activity.activity || [],
    };
    triggerRender();
  } catch (e) {
    state.dashboard = null;
    console.error('Failed to load dashboard', e);
    triggerRender();
  }
}

export async function loadDashboardData() {
  try {
    const r = await api.get('/dashboard/data');
    const data = await r.json();
    if (state.dashboard) {
      state.dashboard.data = data;
    }
  } catch (e) {
    console.error('Failed to load dashboard data', e);
  }
}

// Admin
export async function loadAdmin() {
  try {
    const keys = Object.keys(ADMIN_TABS);
    const promises = keys.map((k: string) => {
      const s = (ADMIN_TABS as any)[k];
      const path = String(s.apiPath || '').replace(/^\/+/, '').replace(/^api\//, '');
      return api
        .get('/' + path)
        .then((r: any) => r.json())
        .catch(() => {
          const d: any = {};
          d[s.listKey] = [];
          return d;
        });
    });
    const results = await Promise.all(promises);
    const data: any = {};
    keys.forEach((k: string, i: number) => {
      const s = (ADMIN_TABS as any)[k];
      data[k] = results[i][s.listKey] || [];
    });
    state.adminData = data;
    if (!state.adminTab || !(state.adminTab in state.adminData)) {
      state.adminTab = keys[0] || 'prompts';
    }
    triggerRender();
  } catch (e) {
    console.error('Failed to load admin data', e);
  }
}

// Connectors
export async function loadConnectors() {
  state.view = 'connectors';
  state.connectorsLoading = true;
  try {
    const r = await api.get('/connectors');
    const data = await r.json();
    state.connectors = { enterprise: data.enterprise || [], social: data.social || [] };
  } catch (e) {
    state.connectors = { enterprise: [], social: [] };
  }
  state.connectorsLoading = false;
  triggerRender();
}

// Credentials
export async function loadCredentials() {
  try {
    const r = await api.get('/credentials');
    const data = await r.json();
    state.credentials = data.credentials || [];
    triggerRender();
  } catch (e) {
    state.credentials = [];
  }
}

// SSO
export async function loadSSOProviders() {
  try {
    const r = await api.get('/sso/providers');
    const data = await r.json();
    state.ssoProviders = data.providers || [];
    triggerRender();
  } catch (e) {
    state.ssoProviders = [];
  }
}

// OAuth accounts
export async function loadOAuthAccounts() {
  try {
    const r = await api.get('/oauth/accounts');
    const data = await r.json();
    state.oauthAccounts = data.accounts || [];
    triggerRender();
  } catch (e) {
    state.oauthAccounts = [];
  }
}

// Password providers
export async function loadPasswordProviders() {
  try {
    const r = await api.get('/password-providers');
    state.importProviders = await r.json();
    triggerRender();
  } catch (e) {
    state.importProviders = [];
  }
}
